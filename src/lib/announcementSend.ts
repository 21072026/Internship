// The fan-out of one announcement (#1721) — shared by the immediate send
// (POST /api/admin/announcements) and the scheduled one (the
// `announcement.send` job), so the two cannot deliver differently.
//
// Who receives it is the sending tenant's active people narrowed by the
// announcement's audience criteria (src/lib/announcementAudience.ts), resolved
// HERE, at send time. The in-app rows carry `announcementId` (#1162), so a later
// edit rewrites them and a delete takes them; the mail half goes through
// mailAnnouncement() and sendEmail() as before.
//
// SERVER-ONLY.

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { recordOptOuts } from '@/services/emailService';
import { mailAnnouncement } from '@/lib/announcementMail';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { orgWhere, withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { defaultOrgId } from '@/lib/defaultOrg';
import { checkBroadcastQuota } from '@/lib/broadcastQuota';
import { resolveAnnouncementText } from '@/lib/announcementText';
import { logActivity } from '@/lib/activity';
import { audienceWhere, parseAudience, type Audience } from '@/lib/announcementAudience';
import type { Prisma } from '@prisma/client';

const RECIPIENT_SELECT = {
  id: true,
  email: true,
  orgId: true,
  emailNotifications: true,
  notificationPrefs: true,
  preferredLanguage: true,
} as const;

export type AnnouncementRecipient = Prisma.UserGetPayload<{ select: typeof RECIPIENT_SELECT }>;

/** The tenant's active people the audience reaches, read now. */
export function announcementRecipients(tenant: TenantWhere, audience: Audience | null): Promise<AnnouncementRecipient[]> {
  return prisma.user.findMany({
    where: withinTenant({ AND: [{ isActive: true }, audienceWhere(audience)] }, tenant),
    select: RECIPIENT_SELECT,
  });
}

/** Of those, the ones a mail may reach — the same filter the quota is measured against. */
export function announcementMailRecipients(users: AnnouncementRecipient[]): AnnouncementRecipient[] {
  return users.filter((u) => u.email && emailAllowed(u, 'announcements') && emailGroupAllowedForCategory(u, 'announcement'));
}

export interface DeliveryResult {
  emailed: number;
  queued: number;
  held: number;
  skipped: number;
}

/**
 * Write the bell rows and send the mail for an announcement that already
 * exists. The caller has decided who (`users`) and, when mailing, checked the
 * broadcast quota against `mailRecipients`.
 */
export async function deliverAnnouncement(args: {
  announcement: { id: string; text: string; translations: Prisma.JsonValue; link: string | null };
  users: AnnouncementRecipient[];
  mailRecipients: AnnouncementRecipient[];
  image: { data: Buffer; contentType: string; altText?: string | null } | null;
}): Promise<DeliveryResult> {
  const { announcement, users, mailRecipients } = args;
  const translations = (announcement.translations ?? {}) as Record<string, string>;
  // Each row in ITS OWN reader's language (#1163).
  await prisma.notification.createMany({
    data: users.map((u) => ({
      userId: u.id,
      type: 'announcement',
      text: resolveAnnouncementText({ text: announcement.text, translations }, u.preferredLanguage),
      link: announcement.link,
      announcementId: announcement.id,
    })),
  });

  const result: DeliveryResult = { emailed: 0, queued: 0, held: 0, skipped: 0 };
  if (mailRecipients.length === 0) return result;
  const toMail = new Set(mailRecipients.map((u) => u.id));
  // One SKIPPED EmailLog row per honoured opt-out (#2054).
  result.skipped = await recordOptOuts(
    users
      .filter((u) => u.email && !toMail.has(u.id))
      .map((u) => ({ to: u.email, category: 'announcement', subject: 'Announcement (not sent: opted out)', orgId: u.orgId })),
  );
  // The list the quota was checked against, not a second filter over `users`.
  const mailed = await mailAnnouncement({
    recipients: mailRecipients,
    text: announcement.text,
    translations,
    link: announcement.link,
    image: args.image,
  });
  result.emailed = mailed.emailed;
  result.queued = mailed.queued;
  result.held = mailed.held;
  return result;
}

export type ScheduledOutcome = 'sent' | 'not_due_or_taken' | 'quota_refused' | 'missing';

/**
 * The `announcement.send` job body: send one SCHEDULED announcement whose time
 * has come. The claim SCHEDULED → SENDING is one guarded updateMany, so a rerun
 * (or a cancel that won the race) finds nothing to send. A crash after the
 * claim leaves the row SENDING — visible in the history, never sent twice.
 */
export async function dispatchScheduledAnnouncement(id: string, now: Date = new Date()): Promise<ScheduledOutcome> {
  const claimed = await prisma.announcement.updateMany({
    where: { id, status: 'SCHEDULED', scheduledAt: { lte: now } },
    data: { status: 'SENDING' },
  });
  if (claimed.count === 0) return 'not_due_or_taken';
  const row = await prisma.announcement.findUnique({
    where: { id },
    select: {
      id: true,
      text: true,
      translations: true,
      link: true,
      orgId: true,
      audience: true,
      emailRequested: true,
      sentById: true,
      image: { select: { data: true, contentType: true, altText: true } },
    },
  });
  if (!row) return 'missing';

  const orgId = row.orgId ?? (await defaultOrgId());
  const users = await announcementRecipients(await orgWhere(orgId), parseAudience(row.audience));
  const mailRecipients = row.emailRequested ? announcementMailRecipients(users) : [];
  if (mailRecipients.length > 0) {
    const quota = await checkBroadcastQuota({ orgId, requested: mailRecipients.length });
    if (!quota.allowed) {
      // Refused whole, as on an immediate send — and recorded, not retried:
      // the month's allowance does not come back by trying again in a minute.
      await prisma.announcement.update({ where: { id }, data: { status: 'CANCELED' } });
      logger.warning('announcement.scheduled_quota_refused', { announcementId: id, requested: mailRecipients.length });
      return 'quota_refused';
    }
  }
  const delivered = await deliverAnnouncement({
    announcement: row,
    users,
    mailRecipients,
    image: row.image ? { data: Buffer.from(row.image.data), contentType: row.image.contentType, altText: row.image.altText } : null,
  });
  await prisma.announcement.update({
    where: { id },
    // createdAt becomes the moment it was broadcast: the reader feed's "nothing
    // from before your account existed" rule and the history order read it.
    data: { status: 'SENT', recipientCount: users.length, emailedCount: delivered.emailed, createdAt: now },
  });
  await logActivity({ action: 'announcement.broadcast_scheduled', actorId: row.sentById, detail: `recipients=${users.length}`, orgId });
  return 'sent';
}
