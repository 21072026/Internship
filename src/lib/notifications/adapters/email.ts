// The e-mail channel (#1711). Two halves:
//
//   deliver()               — the router's side: enqueue ONE `notification.email`
//                             job keyed `notify:<dedupeKey>` and leave the ledger
//                             row QUEUED. A slow or dead SMTP server never sits
//                             inside the request that raised the notification.
//   runNotificationEmail()  — the job's side: render the event's template in the
//                             recipient's language, hand it to sendEmail() with the
//                             group's `notify-<group>` category, and settle the
//                             ledger row SENT / SKIPPED / FAILED.
//
// The DECISION (category switch, e-mail master switch, e-mail group) is the
// router's, made once before the row is claimed. sendEmail() then applies its own
// gate again at send time — an opt-out between the event and the job wins, and
// essential (account_security) mail ignores every switch there as it always has.
// Nothing here re-implements either.
//
// At-least-once: the job is keyed, so a re-delivered event enqueues nothing new;
// a job that reruns after sendEmail() accepted the mail sends it again — the same
// contract as every other queued mail (docs/mail-queue.md). A job older than
// STALE_AFTER_MS is dropped as `stale`: rows enqueued while this channel had no
// worker (before #1711) must not wake up as days-old mail.

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { enqueue } from '@/lib/jobs/queue';
// Static, not enqueue()'s lazy default: a lazy import is not resolved through the
// `@/` alias outside Next (the e2e process calling notifyEvent() directly).
import { prismaQueueStore } from '@/lib/jobs/queueStore';
import { notifyEmailCategory } from '@/lib/emailGroups';
import { isLocale, defaultLocale } from '@/i18n/config';
import { eventDef } from '../catalog';
import { settleDelivery } from '../ledger';
import { resolveTemplate } from '../templates';
import type { ChannelAdapter } from './types';

/** A queued notification mail older than this is not worth sending any more. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface NotificationEmailPayload {
  eventKey: string;
  userId: string;
  locale: string;
  params: Record<string, string | number>;
  link: string;
  emailGroup: string;
  delivery: string;
  /** Absent on rows enqueued before #1711. */
  deliveryId?: string;
}

export const emailAdapter: ChannelAdapter = {
  id: 'email',
  available: () => true,
  deliver: async (d) => {
    try {
      const payload: NotificationEmailPayload = {
        eventKey: d.def.key,
        userId: d.userId,
        locale: d.locale,
        params: d.params,
        link: d.link,
        emailGroup: d.def.emailGroup,
        delivery: d.def.delivery,
        deliveryId: d.deliveryId,
      };
      // Prefixed so the notification namespace can never collide with another
      // producer's key on the globally-unique column. A collision with our own
      // key means an earlier attempt enqueued it: the mail is owed exactly once.
      await enqueue('notification.email', payload, { store: prismaQueueStore(), orgId: d.orgId, idempotencyKey: `notify:${d.dedupeKey}`, trigger: 'event', maxAttempts: 3 });
      return { status: 'QUEUED' };
    } catch (e) {
      return { status: 'FAILED', error: String(e) };
    }
  },
};

export type NotificationEmailOutcome = 'sent' | 'queued' | 'held' | 'skipped' | 'no_user' | 'unknown_event' | 'stale';

/** The `notification.email` job body (registered in src/jobs/index.ts). */
export async function runNotificationEmail(
  payload: NotificationEmailPayload,
  ctx: { createdAt: Date; attempt: number; maxAttempts: number; now?: Date },
): Promise<NotificationEmailOutcome> {
  const settle = async (status: 'SENT' | 'SKIPPED' | 'FAILED', extra?: Parameters<typeof settleDelivery>[2]) => {
    if (payload.deliveryId) await settleDelivery(payload.deliveryId, status, extra);
  };
  const now = ctx.now ?? new Date();
  if (now.getTime() - ctx.createdAt.getTime() > STALE_AFTER_MS) {
    await settle('SKIPPED', { skipReason: 'stale' });
    return 'stale';
  }
  const def = eventDef(payload.eventKey);
  if (!def) {
    logger.error('notification.email for an unknown event', { eventKey: payload.eventKey });
    await settle('SKIPPED', { skipReason: 'unknown_event' });
    return 'unknown_event';
  }
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, fullName: true, orgId: true, isActive: true },
  });
  if (!user || !user.isActive || !user.email) {
    await settle('SKIPPED', { skipReason: user && !user.email ? 'no_address' : 'no_user' });
    return 'no_user';
  }
  const locale = isLocale(payload.locale) ? payload.locale : defaultLocale;
  const template = await resolveTemplate(def.key, locale, { orgId: user.orgId, params: payload.params, recipientName: user.fullName });
  try {
    const { sendNotificationEmail } = await import('@/services/emailService');
    const result = await sendNotificationEmail({
      to: user.email,
      userId: user.id,
      orgId: user.orgId,
      locale,
      subject: template.subject,
      html: template.html,
      link: payload.link,
      category: notifyEmailCategory(def.emailGroup),
    });
    if (result === 'SKIPPED') {
      await settle('SKIPPED', { skipReason: 'mail_skipped', templateId: template.templateId ?? `notifications.events.${def.key}` });
      return 'skipped';
    }
    // SENT, QUEUED (the mail outbox owns its retries now) and HELD (an operator
    // releases it) all mean the notification was handed to the mail system.
    await settle('SENT', { templateId: template.templateId ?? `notifications.events.${def.key}` });
    return result === 'HELD' ? 'held' : result === 'QUEUED' ? 'queued' : 'sent';
  } catch (e) {
    if (ctx.attempt < ctx.maxAttempts) throw e;
    await settle('FAILED', { error: String(e) });
    return 'skipped';
  }
}
