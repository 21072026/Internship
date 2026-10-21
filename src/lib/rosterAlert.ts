import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { sendEmail } from '@/services/emailService';
import { dedupeKeyFor } from '@/lib/mailDeliveryRule';
import type { RosterIngestResult } from '@/lib/rosterIngest';

// The roster-feed alert (#1966). A silent mass deactivation is the failure this
// feature is designed against, so two outcomes always mail somebody: a run a
// safety valve stopped, and any run that switched an account off. Recipients
// are the operator (`ALERT_EMAIL_TO`, the convention of every other ops alert)
// and the tenant's own `Organization.supportEmail` — the person who has to fix
// the export. Category `ops-alert`: essential, never held for approval.
//
// The mail names counts and the feed, never a person: it goes to an address
// that may be a shared inbox, and the run log is where names are read.

const ALERT_CATEGORY = 'ops-alert';

export function rosterAlertDue(result: RosterIngestResult): boolean {
  return result.outcome === 'ABORTED_SAFETY' || Boolean(result.safety) || (result.deprovision?.deactivated ?? 0) > 0;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function buildRosterAlert(feedName: string, result: RosterIngestResult): { subject: string; html: string } {
  const name = escape(feedName);
  if (result.safety) {
    return {
      subject: `Roster feed "${feedName}" stopped by a safety valve`,
      html:
        `<p>The roster feed <strong>${name}</strong> was stopped before it changed anything.</p>` +
        `<p>Reason: ${escape(result.message ?? result.safety.reason)}</p>` +
        '<p>Check the export (a truncated file, a wrong path or a changed column map looks exactly like everyone leaving). ' +
        'If the change is real, an admin can approve the run from the roster feeds console.</p>',
    };
  }
  const d = result.deprovision!;
  return {
    subject: `Roster feed "${feedName}" deactivated ${d.deactivated} account(s)`,
    html:
      `<p>The roster feed <strong>${name}</strong> deactivated <strong>${d.deactivated}</strong> account(s) ` +
      'that were absent from the feed past the grace period. Their sessions and remembered devices were revoked; ' +
      'nothing was deleted, and an account that reappears in the feed is reactivated.</p>' +
      (d.plan.refused.length
        ? `<p>${d.plan.refused.length} account(s) were left active on purpose (last admin or SSO break-glass account).</p>`
        : '') +
      '<p>The run log in the roster feeds console lists every account by name.</p>',
  };
}

/** Mail the alert to the operator and the tenant. Never throws. */
export async function alertRosterRun(
  feed: { id: string; orgId: string; name: string },
  result: RosterIngestResult,
): Promise<number> {
  if (!rosterAlertDue(result)) return 0;
  const message = buildRosterAlert(feed.name, result);
  const org = await prisma.organization
    .findUnique({ where: { id: feed.orgId }, select: { supportEmail: true } })
    .catch(() => null);
  const recipients = [...new Set([process.env.ALERT_EMAIL_TO, org?.supportEmail].filter((a): a is string => Boolean(a)))];
  if (!recipients.length) {
    logger.warning('Roster feed alert has no recipient', { feedId: feed.id, outcome: result.outcome });
    return 0;
  }
  let sent = 0;
  for (const [i, to] of recipients.entries()) {
    try {
      const delivery = await sendEmail({
        to,
        subject: message.subject,
        html: message.html,
        category: ALERT_CATEGORY,
        orgId: feed.orgId,
        dedupeKey: dedupeKeyFor({ kind: 'ops', alert: `roster-${result.run?.id ?? feed.id}-${i}`, at: new Date() }),
        // no-user-row: ALERT_EMAIL_TO is an operator address from the server
        // env and supportEmail is the tenant's configured contact address —
        // neither is a User row with preferences or an unsubscribe token.
      });
      if (delivery !== 'SKIPPED') sent += 1;
    } catch (e) {
      logger.error('Roster feed alert could not be delivered', { feedId: feed.id, error: String(e) });
    }
  }
  return sent;
}
