// When a mentorship request runs out (#1775). PURE — no Prisma, no clock of
// its own — so it is unit-tested and read the same way by the sweep
// (src/lib/requestExpiry.ts, the only writer), the create route and both
// screens that show "expires in N days".
//
// A request nobody answers is worse than a refused one: the mentee may not ask
// anyone else while it is PENDING (the `already_pending` guard). So:
//
//   day 7  — ONE nudge to whoever holds it (the named mentor, else the org's
//            admins). Exactly one, ever: the same sender-reputation reasoning
//            the dormant first-contact sweep is built on (no third mail there,
//            no second nudge here).
//   day 14 — the request EXPIRES and the mentee is told they can ask someone
//            else. No stage, no relation, nothing else is touched.
//
// A request from before the column existed has no `expiresAt`; it reads as
// `createdAt + REQUEST_TTL_DAYS`, so the rule never depends on a backfill.

export const REQUEST_TTL_DAYS = 14;
export const REQUEST_NUDGE_AFTER_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;

export interface ExpiringRequest {
  status: string;
  createdAt: Date;
  expiresAt?: Date | null;
  nudgeSentAt?: Date | null;
}

/** The instant a request created at `createdAt` expires. */
export function requestExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + REQUEST_TTL_DAYS * DAY);
}

/** The effective expiry: the stored one, else the default from `createdAt`. */
export function effectiveExpiry(req: Pick<ExpiringRequest, 'createdAt' | 'expiresAt'>): Date {
  return req.expiresAt ?? requestExpiresAt(req.createdAt);
}

/** Is this request still blocking the mentee (PENDING and not past its expiry)? */
export function isLivePending(req: ExpiringRequest, now: Date): boolean {
  return req.status === 'PENDING' && effectiveExpiry(req).getTime() > now.getTime();
}

/**
 * What the daily sweep owes this request today: expire it, nudge it once, or
 * nothing. Expiry wins over a nudge that is also due (a request first seen on
 * day 15 is not nudged and then expired in the same pass).
 */
export function expiryAction(req: ExpiringRequest, now: Date): 'expire' | 'nudge' | null {
  if (req.status !== 'PENDING') return null;
  if (effectiveExpiry(req).getTime() <= now.getTime()) return 'expire';
  if (req.nudgeSentAt) return null;
  return now.getTime() - req.createdAt.getTime() >= REQUEST_NUDGE_AFTER_DAYS * DAY ? 'nudge' : null;
}

/** Whole days until expiry, never below 0 — the "expires in N days" badge. */
export function daysUntilExpiry(req: Pick<ExpiringRequest, 'createdAt' | 'expiresAt'>, now: Date): number {
  return Math.max(0, Math.ceil((effectiveExpiry(req).getTime() - now.getTime()) / DAY));
}

/**
 * The SQL twin of `isLivePending()` — a `MentorshipRequest` filter matching the
 * requests that still block the mentee at `now`. A NULL `expiresAt` reads as
 * `createdAt + REQUEST_TTL_DAYS`, exactly as `effectiveExpiry()` does. Plain
 * object, no Prisma import, so this file stays pure.
 */
export function livePendingRequestWhere(now: Date) {
  return {
    status: 'PENDING' as const,
    OR: [{ expiresAt: { gt: now } }, { expiresAt: null, createdAt: { gt: new Date(now.getTime() - REQUEST_TTL_DAYS * DAY) } }],
  };
}
