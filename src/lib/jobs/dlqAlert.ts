import cron from 'node-cron';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { sendEmail, type EmailDeliveryResult } from '@/services/emailService';
import {
  buildDeadLetterAlert,
  normalizeReason,
  type DeadLetterGroup,
  type DeadLetterReason,
  type DeadLetterSummary,
} from '@/lib/jobs/dlqAlertMessage';

// Daily dead-letter alert (#1674).
//
// A dead-letter queue nobody looks at is a folder of lost work. Once a day this
// module asks one question — is anything in it? — and mails the operator when
// the answer is yes.
//
// GREEN IS SILENT. An empty queue sends nothing at all: no message, no EmailLog
// row, no log line above debug. That is the discipline the e2e reporter
// (scripts/e2e-report-email.mjs) and the k6 reporter (scripts/k6-report-email.mjs)
// already follow, and for the same reason: a daily "all clear" trains the
// reader to archive the alert unread, and then the one that matters is archived
// too.
//
// WHAT THE MAIL SAYS is bounded on purpose — how many, since when, which job
// types, and the distinct failure reasons with counts. Never a dump of every
// row, and never a payload: the payload is the one part of a job that can carry
// a user's data, and this mail goes to a configured address, not to a session.
//
// The alert address is ALERT_EMAIL_TO, the established operator address (also
// used by the e-mail health alert and .github/workflows/backup-verify.yml).

export type { DeadLetterGroup, DeadLetterReason, DeadLetterSummary };

const ALERT_CATEGORY = 'ops-alert';

// How many rows the failure-reason histogram is built from. The per-name counts
// are exact (a grouped COUNT), but the reasons need the rows themselves, and a
// dead-letter table with ten thousand rows in it is a problem this mail should
// report rather than read end to end.
const REASON_SAMPLE_LIMIT = 200;

export async function getDeadLetterSummary(): Promise<DeadLetterSummary> {
  const where = { status: 'DEAD_LETTER' as const };

  const [total, grouped, oldest, sample] = await Promise.all([
    prisma.job.count({ where }),
    prisma.job.groupBy({
      by: ['name'],
      where,
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    prisma.job.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    prisma.job.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: REASON_SAMPLE_LIMIT,
      select: { lastError: true },
    }),
  ]);

  const byName: DeadLetterGroup[] = grouped
    .map((row) => ({
      name: row.name,
      count: row._count._all,
      lastFailedAt: row._max.updatedAt?.toISOString() ?? null,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const histogram = new Map<string, number>();
  for (const row of sample) {
    const reason = normalizeReason(row.lastError);
    histogram.set(reason, (histogram.get(reason) ?? 0) + 1);
  }
  const reasons: DeadLetterReason[] = [...histogram.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return {
    total,
    oldestAt: oldest?.createdAt.toISOString() ?? null,
    byName,
    reasons,
    reasonsSampledFrom: sample.length,
  };
}

export interface DeadLetterAlertRun {
  /**
   * True only when the transport actually accepted the message. A SKIPPED
   * delivery (no SMTP configured, demo mode, preference gate) is NOT sent —
   * see the note on the send below.
   */
  sent: boolean;
  total: number;
  /** What `sendEmail` reported. Absent when no send was attempted at all. */
  delivery?: EmailDeliveryResult;
  /** Why nothing was delivered, when `sent` is false and the queue is not empty. */
  reason?: 'no_alert_address' | 'not_delivered' | 'send_failed';
}

/**
 * The daily run. Sends at most one e-mail, and none at all when the queue is
 * empty or ALERT_EMAIL_TO is unset.
 *
 * Two things make the *result* worth more than a boolean. First, the alert
 * travels by the very channel it may have to report on, so — exactly as
 * `alertEmailHealth` does (#1190) — the durable record is written FIRST, to
 * ActivityLog, and is there even when the mail cannot leave the box. Second,
 * "did not throw" is not "was delivered": `sendEmail` answers 'SKIPPED' without
 * throwing on three paths (unsubscribed group, demo mode, SMTP_USER unset), and
 * #1431 exists because four routes read that silence as success. So the outcome
 * is captured and reported, and `sent` means SENT.
 */
export async function runDeadLetterAlert(): Promise<DeadLetterAlertRun> {
  const summary = await getDeadLetterSummary();
  const message = buildDeadLetterAlert(summary);
  if (!message) return { sent: false, total: 0 };

  // The durable signal. ActivityLog.detail is VARCHAR(191) and an oversized
  // value is silently dropped (P2000, the #1268 lesson), so this is one small
  // capped object: how many, since when, and the worst offender by name.
  const detail = JSON.stringify({
    total: summary.total,
    oldestAt: summary.oldestAt,
    topName: summary.byName[0]?.name.slice(0, 64) ?? null,
  }).slice(0, 191);
  await logActivity({ level: 'error', action: 'jobs.dlq_alert', targetType: 'job', detail });

  const alertTo = process.env.ALERT_EMAIL_TO;
  if (!alertTo) {
    // Loud in the log rather than silent: the queue IS unhealthy, and the only
    // reason nobody is being told is a missing setting.
    logger.warning('Dead-letter jobs are waiting but ALERT_EMAIL_TO is unset', { total: summary.total });
    return { sent: false, total: summary.total, reason: 'no_alert_address' };
  }

  let delivery: EmailDeliveryResult;
  try {
    delivery = await sendEmail({
      to: alertTo,
      subject: message.subject,
      html: message.html,
      category: ALERT_CATEGORY,
      // no-user-row: ALERT_EMAIL_TO is an operator alert address configured in
      // the server env, not a User row — there is no preference to read and no
      // unsubscribe token to mint for it.
    });
  } catch (e) {
    logger.error('Dead-letter alert could not be delivered', { error: String(e), total: summary.total });
    return { sent: false, total: summary.total, delivery: 'FAILED', reason: 'send_failed' };
  }

  if (delivery !== 'SENT') {
    // The queue is unhealthy AND the alert about it never left. The EmailLog row
    // records why; this line and the ActivityLog row above are what an operator
    // can find without reading the ledger.
    logger.warning('Dead-letter alert was not delivered', { delivery, total: summary.total });
    return { sent: false, total: summary.total, delivery, reason: 'not_delivered' };
  }
  return { sent: true, total: summary.total, delivery };
}

const tasks = new Map<string, ReturnType<typeof cron.schedule>>();

/**
 * Registers the daily dead-letter check in this server process. Idempotent — a
 * retried call from `/api/cron/start` is harmless.
 *
 * Registered from `/api/cron/start` rather than from `initCronJobs()`, for the
 * same reason the newsletter cron is (#1469): this module imports
 * `emailService`, so registering it there would make emailService import it
 * back and turn a one-way dependency into a cycle.
 *
 * node-cron is the carrier only until the queue can schedule itself: #1673's
 * worker and the scheduler story turn this into a `jobs.dlq-alert` handler
 * registered on the queue, and this timer goes away with the other twelve.
 * `runDeadLetterAlert()` is the handler either way.
 */
export function initDeadLetterAlertCron() {
  if (tasks.has('jobs-dlq-alert')) return;

  // 06:45 UTC — offset from every other daily slot (07:30 activity digests,
  // 08:15/08:30 the Monday weeklies, 09:00 the reminder batch) so it never sits
  // behind the mail-heavy ones.
  const task = cron.schedule('45 6 * * *', async () => {
    try {
      const result = await runDeadLetterAlert();
      // Nothing to say when the queue is clean — the log stays as quiet as the
      // mailbox does. When it is not clean, the line names what actually
      // happened to the mail, not merely that the job ran.
      if (result.total > 0) logger.warning('Dead-letter alert ran', { ...result });
    } catch (e) {
      logger.error('Dead-letter alert cron failed', { error: String(e) });
    }
  });
  tasks.set('jobs-dlq-alert', task);
}
