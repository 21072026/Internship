import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { runUnscoped } from '@/lib/tenantAmbient';
import { sendEmail } from '@/services/emailService';
import { budgetNameFor, dedupeKeyFor, opsAlertWindow, type MailChannel } from '@/lib/mailDeliveryRule';
import { MAIL_JOB_NAME } from '@/lib/mailWorkerRule';
import { readBudgetHealth } from '@/lib/mailBudgetStore';
import { takeRelayAuthRejected } from '@/lib/mailOpsSignal';
import { BREAKER_OPEN_ALERT_MS, CRITICAL_PENDING_ALERT_MS, mailOpsAlertsDue, type MailOpsAlertKind } from '@/lib/mailOpsRule';

// The mail queue's operator alerts (#2953). Three conditions, each one alert
// per hour at most — `ops:<kind>:<hour>` is the queued alert mail's
// de-duplication key, so however many replicas and restarts raise it, one copy
// leaves; this process also remembers the key, so it writes one ActivityLog row
// per kind per hour rather than one per tick:
//
//   mail-critical-waiting — the oldest CRITICAL mail (a sign-in link, a reset)
//                           has been PENDING for more than 5 minutes;
//   mail-breaker-open     — the relay has refused every session for more than
//                           15 minutes (`MailBudget.pausedSince`);
//   mail-relay-auth       — the relay rejected our credentials (EAUTH): nothing
//                           will leave until somebody fixes the secret.
//
// Run by the drain route after every tick (`evaluateMailOps()`). The auth flag
// is read every time (in memory); the two database facts at most once a minute
// per process. The durable signals are the `mail_ops.alert` log line and the
// ActivityLog row, written FIRST: the alert travels by the very channel it
// reports on, so during an outage the mail itself waits on the queue with
// everything else and leaves when the relay does. Same discipline as the
// delivery-health and dead-letter alerts. Never an address, never the relay's
// text — counts, ages and a kind.

const CHECK_EVERY_MS = 60_000;
let lastCheckAt = 0;
const raised = new Set<string>();

/** Tests: forget this process's throttle and memory. */
export function resetMailOpsAlertsForTests(): void {
  lastCheckAt = 0;
  raised.clear();
}

function channels(): MailChannel[] {
  return process.env.SMTP_BULK_HOST && process.env.SMTP_BULK_USER ? ['primary', 'bulk'] : ['primary'];
}

const TEXT: Record<MailOpsAlertKind, { subject: string; body: string }> = {
  'mail-critical-waiting': {
    subject: '[CRM] Critical mail has been waiting for more than 5 minutes',
    body: 'A sign-in link, password reset or other critical mail has been on the mail queue for more than 5 minutes. The relay is paused, refusing, or the drain is not running.',
  },
  'mail-breaker-open': {
    subject: '[CRM] Mail relay has been refusing for more than 15 minutes',
    body: 'The outbound relay has refused every session for more than 15 minutes; the queue is holding the mail and retrying on the pause ladder.',
  },
  'mail-relay-auth': {
    subject: '[CRM] Mail relay rejected the SMTP credentials',
    body: 'The outbound relay rejected the SMTP user or password (EAUTH). No mail will leave until the credentials in the server environment are fixed; the queue keeps it until then.',
  },
};

export interface MailOpsEvaluation {
  checked: boolean;
  raised: MailOpsAlertKind[];
}

/**
 * Evaluate the three conditions and raise what is due. Never throws: an alert
 * that cannot be evaluated must not fail the drain tick that called it.
 */
export async function evaluateMailOps(opts: { authRejected?: boolean; now?: Date; force?: boolean } = {}): Promise<MailOpsEvaluation> {
  const now = opts.now ?? new Date();
  const authRejected = takeRelayAuthRejected() || !!opts.authRejected;
  const dbDue = opts.force || Date.now() - lastCheckAt >= CHECK_EVERY_MS;
  if (!dbDue && !authRejected) return { checked: false, raised: [] };
  try {
    let oldestCriticalQueuedAt: Date | null = null;
    const breakers: { channel: string; paused: boolean; outageMs: number | null }[] = [];
    if (dbDue) {
      lastCheckAt = Date.now();
      const oldest = await runUnscoped(() =>
        prisma.job.findFirst({
          where: { name: MAIL_JOB_NAME, status: 'PENDING', priority: { gte: 100 } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
      );
      oldestCriticalQueuedAt = oldest?.createdAt ?? null;
      for (const ch of channels()) {
        const b = await readBudgetHealth(budgetNameFor(ch), now).catch(() => null);
        if (b) breakers.push({ channel: ch, paused: b.paused, outageMs: b.outageMs });
      }
    }
    const due = mailOpsAlertsDue({ now, oldestCriticalQueuedAt, breakers, authRejected });
    const done: MailOpsAlertKind[] = [];
    for (const kind of due) {
      const facts = {
        kind,
        criticalWaitingSec: oldestCriticalQueuedAt ? Math.round((now.getTime() - oldestCriticalQueuedAt.getTime()) / 1000) : null,
        outageSec: Math.max(0, ...breakers.map((b) => Math.round((b.outageMs ?? 0) / 1000))),
      };
      if (await raise(kind, facts, now)) done.push(kind);
    }
    return { checked: dbDue, raised: done };
  } catch (e) {
    logger.error('mail_ops.evaluate_failed', { error: e instanceof Error ? e.name : 'unknown' });
    return { checked: dbDue, raised: [] };
  }
}

async function raise(
  kind: MailOpsAlertKind,
  facts: { kind: string; criticalWaitingSec: number | null; outageSec: number },
  now: Date,
): Promise<boolean> {
  const key = dedupeKeyFor({ kind: 'ops', alert: kind, at: opsAlertWindow(now) });
  if (raised.has(key)) return false;
  if (raised.size > 64) raised.clear();
  raised.add(key);

  logger.error('mail_ops.alert', facts);
  // ActivityLog.detail is VARCHAR(191): one small object, capped.
  await logActivity({ level: 'error', action: 'mail_ops.alert', targetType: 'email', detail: JSON.stringify(facts).slice(0, 191) });

  const alertTo = process.env.ALERT_EMAIL_TO;
  if (!alertTo) return true;
  const text = TEXT[kind];
  const lines = [
    facts.criticalWaitingSec !== null ? `<li>Oldest critical mail waiting: ${facts.criticalWaitingSec} s (threshold ${CRITICAL_PENDING_ALERT_MS / 1000} s)</li>` : '',
    facts.outageSec > 0 ? `<li>Relay refusing for: ${facts.outageSec} s (threshold ${BREAKER_OPEN_ALERT_MS / 1000} s)</li>` : '',
  ].join('');
  try {
    await sendEmail({
      to: alertTo,
      subject: text.subject,
      html: `<p>${text.body}</p>${lines ? `<ul>${lines}</ul>` : ''}<p>Live state: /api/health?jobs=1 (the <code>mail</code> block) and the Queue tab under Settings → Email deliverability.</p>`,
      category: 'ops-alert',
      dedupeKey: key,
      // Queued, never inline: one copy per hour leaves however many replicas
      // raise it, and an inline attempt against a relay that is refusing
      // would only hold this tick.
      queueOnly: true,
      // no-user-row: ALERT_EMAIL_TO is an operator address from the server
      // env, not a User row — no preference to read, no unsubscribe token.
    });
  } catch (e) {
    logger.error('mail_ops.alert_not_queued', { kind, error: e instanceof Error ? e.name : 'unknown' });
  }
  return true;
}
