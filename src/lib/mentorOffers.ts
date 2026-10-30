// Mentor Offers (#1809) — the Prisma-aware half: the one writer of MentorOffer.
// The verdicts (may this mentor offer, is a reminder due, is it expired) come
// from the pure src/lib/mentorOfferRule.ts; this file reads the facts, writes
// the row and tells people. Server-only.
//
// Three properties are load-bearing:
//   • a mentee is reachable ONLY with User.openToOffers on — the listing, the
//     create path and every mail check it, and nothing here builds a general
//     mentee directory;
//   • accepting goes through decideMentorshipRequest(), the shared path, so the
//     plan gate, the one-active-mentor guard (#419) and both sides' notices are
//     the same as for any other pairing;
//   • the mentee hears at most twice per offer: the offer, and one reminder.

import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { notify, notifyIfAllowed } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { logActivity } from '@/lib/activity';
import { logger } from '@/lib/logger';
import { sendMentorOfferEmail } from '@/services/emailService';
import { getMentorAvailability } from '@/lib/mentorAvailability';
import { decideMentorshipRequest, type DecisionResult } from '@/lib/mentorshipDecision';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { isBenched } from '@/lib/participantState';
import { isExpired, offerExpiresAt, offerRefusal, reminderDue, weekAgo, type OfferRefusal } from '@/lib/mentorOfferRule';
import { livePendingRequestWhere, requestExpiresAt } from '@/lib/requestExpiryRule';

/** What a mentor may see about an offerable mentee — the profile, never contact details. */
export const OFFERABLE_MENTEE_SELECT = {
  id: true,
  fullName: true,
  displayName: true,
  avatarUrl: true,
  university: true,
  department: true,
  city: true,
  country: true,
  skills: true,
  interests: true,
  targetPosition: true,
} as const;

/**
 * Mentees a mentor may offer to: opted in, active, unmatched, no request
 * waiting. "Waiting" is #1775's rule: a PENDING request past its expiry no
 * longer blocks, even before the morning sweep has marked it EXPIRED.
 */
export function offerableMenteesWhere(tenant: TenantWhere, now: Date = new Date()) {
  return withinTenant(
    {
      role: 'MENTEE' as const,
      isActive: true,
      openToOffers: true,
      menteeRelations: { none: { status: 'ACTIVE' as const } },
      mentorshipRequests: { none: livePendingRequestWhere(now) },
    },
    tenant
  );
}

export type CreateOfferResult =
  | { ok: true; offerId: string }
  | { ok: false; status: 403 | 404 | 409; code: OfferRefusal | 'not_found' | 'mentor_benched' };

export async function createMentorOffer(opts: { session: Session; tenant: TenantWhere; menteeId: string; message: string | null; request?: Request }): Promise<CreateOfferResult> {
  const { session, tenant, menteeId, message, request } = opts;
  const now = new Date();
  const mentor = await prisma.user.findFirst({
    where: withinTenant({ id: session.user.id, isActive: true }, tenant),
    select: { id: true, fullName: true, orgId: true, mentorCapacity: true, acceptingMentees: true, selfMatchLimit: true, participantState: true },
  });
  // A mentee outside the tenant, not a MENTEE, inactive — or not opted in —
  // all read as "not offerable"; nothing is revealed about them.
  const mentee = await prisma.user.findFirst({
    where: withinTenant({ id: menteeId, role: 'MENTEE' as const, isActive: true }, tenant),
    select: { id: true, fullName: true, email: true, orgId: true, openToOffers: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true },
  });
  if (!mentor || !mentee) return { ok: false, status: 404, code: 'not_found' };
  // A benched mentor (#1778) takes no new mentee, by offer or otherwise.
  if (isBenched(mentor)) return { ok: false, status: 409, code: 'mentor_benched' };

  const [activeCount, menteeActive, menteePending, previous, pendingCount, sentLast7Days] = await Promise.all([
    prisma.mentorshipRelation.count({ where: { mentorId: mentor.id, status: 'ACTIVE' } }),
    prisma.mentorshipRelation.count({ where: { menteeId, status: 'ACTIVE' } }),
    prisma.mentorshipRequest.count({ where: { menteeId, ...livePendingRequestWhere(now) } }),
    prisma.mentorOffer.findFirst({ where: { mentorId: mentor.id, menteeId, status: { in: ['PENDING', 'DECLINED'] } }, select: { status: true } }),
    prisma.mentorOffer.count({ where: { mentorId: mentor.id, status: 'PENDING' } }),
    prisma.mentorOffer.count({ where: { mentorId: mentor.id, createdAt: { gte: weekAgo(now) } } }),
  ]);
  const refusal = offerRefusal({
    // Admin context: offering is the mentor's own act, not a mentee picking them.
    mentorAvailability: getMentorAvailability({ mentorCapacity: mentor.mentorCapacity, activeMenteeCount: activeCount, acceptingMentees: mentor.acceptingMentees }).status,
    menteeOpenToOffers: mentee.openToOffers,
    menteeHasActiveRelation: menteeActive > 0,
    menteeHasPendingRequest: menteePending > 0,
    previous: (previous?.status as 'PENDING' | 'DECLINED' | undefined) ?? null,
    mentorPendingCount: pendingCount,
    mentorSentLast7Days: sentLast7Days,
  });
  if (refusal === 'not_open_to_offers') return { ok: false, status: 404, code: 'not_found' };
  if (refusal) return { ok: false, status: refusal === 'mentor_unavailable' ? 403 : 409, code: refusal };

  const offer = await prisma.mentorOffer.create({
    data: { orgId: mentor.orgId, mentorId: mentor.id, menteeId, message, expiresAt: offerExpiresAt(now) },
    select: { id: true },
  });

  await notifyIfAllowed(menteeId, 'mentorship', 'mentor_offer.new', { mentorName: mentor.fullName }, '/portal');
  if (mentee.email && emailAllowed(mentee, 'mentorship') && emailGroupAllowedForCategory(mentee, 'mentor-offer')) {
    await sendMentorOfferEmail({
      to: mentee.email,
      menteeName: mentee.fullName,
      mentorName: mentor.fullName,
      message,
      kind: 'new',
      orgId: mentee.orgId,
      userId: mentee.id,
      locale: mentee.preferredLanguage,
    }).catch((e) => logger.error('mentor_offer.mail_failed', { error: e instanceof Error ? e.name : 'unknown' }));
  }
  await logActivity({
    action: 'mentor_offer.created',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'mentor_offer',
    targetId: offer.id,
    // Who to whom, never the message.
    detail: `mentor ${mentor.id} → mentee ${menteeId}`,
    request,
  });
  return { ok: true, offerId: offer.id };
}

/** The mentor withdraws their own pending offer. Not theirs, or not pending → 404. */
export async function withdrawMentorOffer(opts: { session: Session; offerId: string; request?: Request }): Promise<boolean> {
  const done = await prisma.mentorOffer.updateMany({
    where: { id: opts.offerId, mentorId: opts.session.user.id, status: 'PENDING' },
    data: { status: 'WITHDRAWN', decidedAt: new Date() },
  });
  if (done.count === 0) return false;
  await logActivity({
    action: 'mentor_offer.withdrawn',
    actorId: opts.session.user.id,
    actorEmail: opts.session.user.email ?? null,
    targetType: 'mentor_offer',
    targetId: opts.offerId,
    request: opts.request,
  });
  return true;
}

/**
 * The mentee answers. Decline: one write, no reason asked, and the mentor is
 * told only "declined". Accept: the offer is claimed (PENDING → ACCEPTED), then a
 * MentorshipRequest naming the mentor is approved through the SHARED decision
 * service; if that refuses (plan gate, already mentored…) the request is removed
 * and the offer goes back to PENDING, so nothing is left half-applied.
 */
export async function answerMentorOffer(opts: { session: Session; offerId: string; action: 'accept' | 'decline'; request?: Request }): Promise<DecisionResult> {
  const { session, offerId, action, request } = opts;
  const now = new Date();
  const offer = await prisma.mentorOffer.findFirst({
    where: { id: offerId, menteeId: session.user.id },
    select: { id: true, status: true, expiresAt: true, mentorId: true, mentor: { select: { fullName: true } } },
  });
  // Another person's offer reads as missing — the id confirms nothing.
  if (!offer) return { status: 404, body: { error: 'Not found' } };
  if (offer.status !== 'PENDING' || isExpired(offer, now)) return { status: 409, body: { error: 'Offer is no longer open', code: 'offer_closed' } };

  const claim = await prisma.mentorOffer.updateMany({
    where: { id: offerId, status: 'PENDING' },
    data: { status: action === 'accept' ? 'ACCEPTED' : 'DECLINED', decidedAt: now },
  });
  if (claim.count === 0) return { status: 409, body: { error: 'Offer is no longer open', code: 'offer_closed' } };
  const menteeName = session.user.name ?? '';

  if (action === 'decline') {
    await notify(offer.mentorId, 'mentor_offer.declined', { menteeName }, '/mentor/offers');
    await logActivity({ action: 'mentor_offer.declined', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'mentor_offer', targetId: offerId, request });
    return { status: 200, body: { ok: true, status: 'DECLINED' } };
  }

  const reopen = () => prisma.mentorOffer.updateMany({ where: { id: offerId, status: 'ACCEPTED' }, data: { status: 'PENDING', decidedAt: null } });
  // One pending request per mentee is the request flow's own rule; an offer
  // does not get to break it.
  if (await prisma.mentorshipRequest.count({ where: { menteeId: session.user.id, ...livePendingRequestWhere(now) } })) {
    await reopen();
    return { status: 409, body: { error: 'You already have a pending request', code: 'already_pending' } };
  }
  const req = await prisma.mentorshipRequest.create({
    data: { menteeId: session.user.id, preferredMentorId: offer.mentorId, expiresAt: requestExpiresAt(now) },
    select: { id: true },
  });
  const result = await decideMentorshipRequest({
    requestId: req.id,
    action: 'approve',
    mentorId: offer.mentorId,
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    restrictToPreferredMentorId: offer.mentorId,
    request,
  });
  if (result.status !== 200) {
    await prisma.mentorshipRequest.deleteMany({ where: { id: req.id, status: 'PENDING' } });
    await reopen();
    return result;
  }
  await notify(offer.mentorId, 'mentor_offer.accepted', { menteeName }, '/mentor');
  await logActivity({ action: 'mentor_offer.accepted', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'mentor_offer', targetId: offerId, request });
  return { status: 200, body: { ok: true, status: 'ACCEPTED' } };
}

/**
 * The daily sweep: PENDING offers past expiry become EXPIRED (silently), and
 * each offer inside its last days gets ONE reminder — claimed by a conditional
 * update on `remindedAt: null`, so a rerun of the job reminds nobody twice.
 * A mentee who has switched openToOffers off since gets no reminder.
 */
export async function sweepMentorOffers(now = new Date()): Promise<{ expired: number; reminded: number }> {
  const expired = await prisma.mentorOffer.updateMany({
    where: { status: 'PENDING', expiresAt: { lte: now } },
    data: { status: 'EXPIRED', decidedAt: now },
  });
  const candidates = await prisma.mentorOffer.findMany({
    where: { status: 'PENDING', remindedAt: null, expiresAt: { gt: now } },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      remindedAt: true,
      mentor: { select: { fullName: true } },
      mentee: { select: { id: true, fullName: true, email: true, orgId: true, openToOffers: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true } },
    },
    take: 500,
  });
  let reminded = 0;
  for (const o of candidates) {
    if (!reminderDue(o, now)) continue;
    const claim = await prisma.mentorOffer.updateMany({ where: { id: o.id, remindedAt: null, status: 'PENDING' }, data: { remindedAt: now } });
    if (claim.count === 0 || !o.mentee.openToOffers) continue;
    reminded += 1;
    await notifyIfAllowed(o.mentee.id, 'mentorship', 'mentor_offer.reminder', { mentorName: o.mentor.fullName }, '/portal');
    if (o.mentee.email && emailAllowed(o.mentee, 'mentorship') && emailGroupAllowedForCategory(o.mentee, 'mentor-offer')) {
      await sendMentorOfferEmail({
        to: o.mentee.email,
        menteeName: o.mentee.fullName,
        mentorName: o.mentor.fullName,
        kind: 'reminder',
        orgId: o.mentee.orgId,
        userId: o.mentee.id,
        locale: o.mentee.preferredLanguage,
      }).catch((e) => logger.error('mentor_offer.mail_failed', { error: e instanceof Error ? e.name : 'unknown' }));
    }
  }
  return { expired: expired.count, reminded };
}
