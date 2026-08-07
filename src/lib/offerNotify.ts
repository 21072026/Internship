// Notification + email side-effects for offer transitions (#809). Shared
// between the offers API route and the expiry cron so both send exactly the
// same in-app notification + email for a given transition.

import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { sendOfferSentEmail, sendOfferDecisionEmail } from '@/services/emailService';

// SENT — notify + (opt-in) email the mentee; they are the one who must act.
export async function notifyOfferSent(offerId: string): Promise<void> {
  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      position: true,
      startDate: true,
      expiresAt: true,
      relation: {
        select: {
          orgId: true,
          mentee: {
            select: {
              id: true,
              fullName: true,
              email: true,
              emailNotifications: true,
              notificationPrefs: true,
              preferredLanguage: true,
            },
          },
        },
      },
      company: { select: { name: true } },
    },
  });
  if (!offer) return;
  const mentee = offer.relation.mentee;
  await notify(mentee.id, 'offer_sent', `You have a new offer: ${offer.position}.`, '/portal');
  if (mentee.email && emailAllowed(mentee, 'mentorship')) {
    await sendOfferSentEmail({
      to: mentee.email,
      fullName: mentee.fullName,
      position: offer.position,
      companyName: offer.company?.name ?? null,
      startDate: offer.startDate,
      expiresAt: offer.expiresAt,
      locale: mentee.preferredLanguage,
      orgId: offer.relation.orgId,
    }).catch((e) => console.error('sendOfferSentEmail failed:', e));
  }
}

// ACCEPTED / DECLINED / EXPIRED — notify + (opt-in) email the admin who
// created the offer; the decision is theirs to act on next.
export async function notifyOfferDecided(offerId: string, outcome: 'ACCEPTED' | 'DECLINED' | 'EXPIRED'): Promise<void> {
  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      position: true,
      relation: { select: { orgId: true, mentee: { select: { fullName: true } } } },
      createdBy: {
        select: {
          id: true,
          fullName: true,
          email: true,
          emailNotifications: true,
          notificationPrefs: true,
          preferredLanguage: true,
        },
      },
    },
  });
  if (!offer) return;
  const admin = offer.createdBy;
  const menteeName = offer.relation.mentee.fullName;
  const text =
    outcome === 'ACCEPTED'
      ? `${menteeName} accepted the ${offer.position} offer.`
      : outcome === 'DECLINED'
        ? `${menteeName} declined the ${offer.position} offer.`
        : `The ${offer.position} offer to ${menteeName} expired.`;
  await notify(admin.id, `offer_${outcome.toLowerCase()}`, text, `/admin/candidates`);
  if (admin.email && emailAllowed(admin, 'mentorship')) {
    await sendOfferDecisionEmail({
      to: admin.email,
      fullName: admin.fullName,
      menteeName,
      position: offer.position,
      outcome,
      locale: admin.preferredLanguage,
      orgId: offer.relation.orgId,
    }).catch((e) => console.error('sendOfferDecisionEmail failed:', e));
  }
}

// Expire SENT offers whose expiresAt has passed (#809), for the scheduled cron.
// Idempotent the same way sendMeetingReminders() is: the status flip is
// claimed with a guarded `updateMany` (status: 'SENT' in the where) BEFORE any
// audit/notify/email — only the caller that wins the claim (count === 1) sends
// anything, so two overlapping cron ticks can never double-transition,
// double-audit or double-mail the same offer.
export async function expireOffers(): Promise<{ checked: number; expired: number }> {
  const now = new Date();
  const due = await prisma.offer.findMany({
    where: { status: 'SENT', expiresAt: { lt: now } },
    select: { id: true },
  });

  let expired = 0;
  for (const o of due) {
    const claim = await prisma.offer.updateMany({
      where: { id: o.id, status: 'SENT' },
      data: { status: 'EXPIRED', decidedAt: now },
    });
    if (claim.count === 0) continue;
    expired++;

    await prisma.auditLog.create({ data: { actorId: 'system', action: 'offer.expire', targetId: o.id } });
    await notifyOfferDecided(o.id, 'EXPIRED');
  }

  return { checked: due.length, expired };
}
