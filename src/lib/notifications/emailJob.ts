// The consumer of the router's e-mail channel (#1710 enqueues, #1719 sends).
//
// A `notification.email` job is "this person is owed this event's mail". It is
// rendered by renderNotificationEmail() — the same function the template
// editor's preview and test send call — and handed to sendEmail(), which applies
// the opt-out gate, the lane, the budget, the queue and the EmailLog row.
//
// AT MOST ONCE PER LEDGER ROW. The router wrote a NotificationDelivery row
// (status QUEUED) under the same dedupe key the job carries (`notify:<key>`).
// The handler claims it QUEUED → SENT with one guarded updateMany BEFORE it
// sends, so a rerun of a job whose mail already left finds the row taken and
// does nothing. A send that throws puts the row back to QUEUED and rethrows, so
// the worker's retry may try again; a crash between the claim and the send
// loses that one mail, the same trade the dormant check-in makes.
//
// WHAT IT DOES NOT SEND
//   * `batched` events: their mail belongs in a digest, which does not exist
//     yet. Sending each one alone would turn a nightly sweep into a mail per
//     record, so the row is settled SKIPPED ('batched_deferred') instead.
//   * a job older than STALE_AFTER_MS: before this consumer existed the router
//     had been enqueuing rows nobody read; a day-old "a recovery code was used"
//     is noise, not a notice. Settled SKIPPED ('stale').

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { sendEmail } from '@/services/emailService';
import { isEmailGroupId } from '@/lib/emailGroups';
import { renderNotificationEmail } from '@/lib/notifications/emailRender';
import { EVENT_MAIL_CATEGORY } from '@/lib/notifications/eventMailRule';
import { openEmail } from '@/lib/notifications/sealedEmail';
import type { JobPayloadMap } from '@/lib/jobs/types';
import type { JobRecord } from '@/lib/jobs/queue';

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

type Payload = JobPayloadMap['notification.email'];
export type NotificationEmailOutcome = 'sent' | 'claimed_elsewhere' | 'batched_deferred' | 'stale' | 'no_user' | 'skipped_by_send' | 'unreadable';

function ledgerKey(job: Pick<JobRecord, 'idempotencyKey'>): string | null {
  const k = job.idempotencyKey;
  return k && k.startsWith('notify:') ? k.slice('notify:'.length) : null;
}

async function settle(dedupeKey: string | null, from: 'QUEUED' | 'SENT', to: 'SENT' | 'SKIPPED' | 'QUEUED' | 'FAILED', extra: { skipReason?: string; error?: string } = {}): Promise<number> {
  if (!dedupeKey) return 1;
  const res = await prisma.notificationDelivery.updateMany({
    where: { dedupeKey, channel: 'email', status: from },
    data: { status: to, ...(extra.skipReason ? { skipReason: extra.skipReason } : {}), ...(extra.error ? { error: extra.error.slice(0, 2000) } : {}) },
  });
  return res.count;
}

export async function runNotificationEmail(payload: Payload, job: JobRecord, now: Date = new Date()): Promise<NotificationEmailOutcome> {
  const key = ledgerKey(job);
  // A pre-rendered mail (#1711) is the site's own, sent now: the batching that
  // defers catalogue mails into a digest does not apply to it.
  if (payload.sealedEmail) return sendPrerendered(payload, payload.sealedEmail, key, job, now);
  if (payload.delivery === 'batched') {
    await settle(key, 'QUEUED', 'SKIPPED', { skipReason: 'batched_deferred' });
    return 'batched_deferred';
  }
  if (now.getTime() - job.runAt.getTime() > STALE_AFTER_MS) {
    await settle(key, 'QUEUED', 'SKIPPED', { skipReason: 'stale' });
    return 'stale';
  }
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, fullName: true, orgId: true },
  });
  if (!user?.email) {
    await settle(key, 'QUEUED', 'SKIPPED', { skipReason: 'no_address' });
    return 'no_user';
  }
  // The claim: the one guarded transition that makes a rerun harmless.
  if ((await settle(key, 'QUEUED', 'SENT')) === 0) return 'claimed_elsewhere';

  const orgId = job.orgId ?? user.orgId;
  try {
    const mail = await renderNotificationEmail({
      eventKey: payload.eventKey,
      locale: payload.locale,
      orgId,
      params: payload.params,
      recipientName: user.fullName,
      link: payload.link,
    });
    // The catalogue gives every event a group; an unknown one (a payload from a
    // future catalogue) is sent as an announcement, which honours opt-outs.
    const group = isEmailGroupId(payload.emailGroup) ? payload.emailGroup : 'announcements';
    const result = await sendEmail({
      to: user.email,
      userId: user.id,
      orgId,
      subject: mail.subject,
      html: mail.html,
      fromName: mail.fromName,
      category: EVENT_MAIL_CATEGORY[group],
      group,
      locale: mail.locale,
      ...(key ? { dedupeKey: `notify:${key}` } : {}),
    });
    if (result === 'SKIPPED') {
      await settle(key, 'SENT', 'SKIPPED', { skipReason: 'send_skipped' });
      return 'skipped_by_send';
    }
    return 'sent';
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error('notification_email.failed', { eventKey: payload.eventKey, error });
    await settle(key, 'SENT', 'QUEUED', { error });
    throw e;
  }
}

/**
 * The pre-rendered path (#1711, option 2a): the call site built the mail, the
 * router decided it may leave, and this hands sendEmail() exactly the fields the
 * site used to pass — so the person receives the same bytes as before, now with
 * a ledger row, the matrix and quiet hours. Same claim-then-send as above.
 */
async function sendPrerendered(payload: Payload, sealed: string, key: string | null, job: JobRecord, now: Date): Promise<NotificationEmailOutcome> {
  if (now.getTime() - job.runAt.getTime() > STALE_AFTER_MS) {
    await settle(key, 'QUEUED', 'SKIPPED', { skipReason: 'stale' });
    return 'stale';
  }
  const mail = openEmail(sealed);
  if (!mail) {
    await settle(key, 'QUEUED', 'FAILED', { error: 'sealed mail could not be opened' });
    return 'unreadable';
  }
  const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { id: true, email: true, orgId: true } });
  if (!user?.email) {
    await settle(key, 'QUEUED', 'SKIPPED', { skipReason: 'no_address' });
    return 'no_user';
  }
  if ((await settle(key, 'QUEUED', 'SENT')) === 0) return 'claimed_elsewhere';
  try {
    const result = await sendEmail({
      to: user.email,
      userId: user.id,
      orgId: job.orgId ?? user.orgId,
      subject: mail.subject,
      html: mail.html,
      category: mail.category,
      ...(mail.fromName !== undefined ? { fromName: mail.fromName } : {}),
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      ...(mail.locale !== undefined ? { locale: mail.locale } : {}),
      ...(key ? { dedupeKey: `notify:${key}` } : {}),
    });
    if (result === 'SKIPPED') {
      await settle(key, 'SENT', 'SKIPPED', { skipReason: 'send_skipped' });
      return 'skipped_by_send';
    }
    return 'sent';
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error('notification_email.failed', { eventKey: payload.eventKey, error });
    await settle(key, 'SENT', 'QUEUED', { error });
    throw e;
  }
}
