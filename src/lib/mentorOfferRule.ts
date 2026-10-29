// Mentor Offers (#1809) — the pure rule: who may offer to whom, the quota,
// and the expiry/reminder clock. Dependency-free and unit-tested
// (scripts/test/mentor-offers.test.mjs); src/lib/mentorOffers.ts reads the
// facts from the database and asks this file for the verdict.
//
// Two limits are deliberately NOT configurable, by a mentor or anyone else:
// the mentee must have opted in (User.openToOffers), and a mentor holds at most
// MAX_PENDING open offers and sends at most MAX_PER_WEEK in any rolling 7 days.
// Those two are the whole difference between a mentor volunteering and cold
// outreach from our sending domain.

import type { MentorAvailabilityStatus } from './mentorAvailability';

export const OFFER_LIMITS = {
  maxPending: 3,
  maxPerWeek: 5,
  ttlDays: 14,
  /** The one reminder goes out once an offer has this many days or fewer left. */
  reminderDaysBefore: 3,
  messageMax: 1000,
} as const;

const DAY = 24 * 60 * 60 * 1000;

export type OfferRefusal =
  | 'mentor_unavailable'
  | 'not_open_to_offers'
  | 'mentee_matched'
  | 'mentee_request_pending'
  | 'already_offered'
  | 'declined_before'
  | 'quota_pending'
  | 'quota_weekly';

export interface OfferFacts {
  /** getMentorAvailability() for the mentor, admin context (an offer is the mentor's own choice). */
  mentorAvailability: MentorAvailabilityStatus;
  /** The target is an active MENTEE in the mentor's tenant who switched openToOffers on. */
  menteeOpenToOffers: boolean;
  menteeHasActiveRelation: boolean;
  menteeHasPendingRequest: boolean;
  /** Status of an earlier offer from THIS mentor to THIS mentee, if any is PENDING or DECLINED. */
  previous: 'PENDING' | 'DECLINED' | null;
  /** The mentor's offers currently PENDING. */
  mentorPendingCount: number;
  /** Offers the mentor created in the last 7 days, any status. */
  mentorSentLast7Days: number;
}

/**
 * Why an offer may not be made, or null when it may. The order matters only for
 * which reason is shown: a mentee who has not opted in is reported as such
 * before anything that would reveal more about them.
 */
export function offerRefusal(f: OfferFacts): OfferRefusal | null {
  if (!f.menteeOpenToOffers) return 'not_open_to_offers';
  if (f.mentorAvailability !== 'available') return 'mentor_unavailable';
  if (f.menteeHasActiveRelation) return 'mentee_matched';
  if (f.menteeHasPendingRequest) return 'mentee_request_pending';
  if (f.previous === 'PENDING') return 'already_offered';
  if (f.previous === 'DECLINED') return 'declined_before';
  if (f.mentorPendingCount >= OFFER_LIMITS.maxPending) return 'quota_pending';
  if (f.mentorSentLast7Days >= OFFER_LIMITS.maxPerWeek) return 'quota_weekly';
  return null;
}

export function offerExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + OFFER_LIMITS.ttlDays * DAY);
}

export function weekAgo(now: Date): Date {
  return new Date(now.getTime() - 7 * DAY);
}

/** A PENDING offer past its expiry. */
export function isExpired(offer: { status: string; expiresAt: Date }, now: Date): boolean {
  return offer.status === 'PENDING' && offer.expiresAt.getTime() <= now.getTime();
}

/** The one reminder: PENDING, not reminded yet, inside the last few days, not yet expired. */
export function reminderDue(offer: { status: string; expiresAt: Date; remindedAt: Date | null }, now: Date): boolean {
  if (offer.status !== 'PENDING' || offer.remindedAt) return false;
  const left = offer.expiresAt.getTime() - now.getTime();
  return left > 0 && left <= OFFER_LIMITS.reminderDaysBefore * DAY;
}
