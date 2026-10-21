// The programme owner's hiring desk (#1874) — the pure half: the windows each
// queue is cut by, and the header arithmetic. No Prisma import; the route
// (src/app/api/admin/hiring/queues/route.ts) turns these into one bounded,
// indexed query per queue, each with its own `take` and a `count()` over the
// same `where` — never a full read filtered in JavaScript (#1436, #1438).

/** Rows shown per queue; the count beside it is the real total. */
export const HIRING_QUEUE_TAKE = 20;
/** "Offers expiring" looks this many days ahead (the offers screen's own preset). */
export const OFFER_EXPIRY_WINDOW_DAYS = 7;
/** The acceptance rate looks back this far, by the day the candidate answered. */
export const ACCEPTANCE_WINDOW_DAYS = 90;
/** Bounds for the `hiringStallDays` setting; anything else reads as the default. */
export const STALL_DAYS_DEFAULT = 14;
const STALL_DAYS_MIN = 1;
const STALL_DAYS_MAX = 365;

export const HIRING_QUEUES = ['awaitingDecision', 'stalledApplications', 'offersExpiring', 'emptyRoles'] as const;
export type HiringQueue = (typeof HIRING_QUEUES)[number];

const DAY_MS = 86_400_000;

/** The stall threshold as stored (a string setting), clamped to something a query can use. */
export function stallDays(raw: string | null | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= STALL_DAYS_MIN && n <= STALL_DAYS_MAX ? n : STALL_DAYS_DEFAULT;
}

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export function daysAhead(now: Date, days: number): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

/** Whole days from `since` to `now` (never negative) — the "N days waiting" figure. */
export function wholeDaysBetween(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS));
}

/** The first instant of the UTC calendar month `now` falls in (the metering convention). */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Accepted ÷ every offer the candidate answered or let lapse in the window,
 * as a whole percentage — null when nothing was decided, so the screen says
 * "no data" rather than a fabricated 0 %. A withdrawn offer is the programme's
 * own decision, not the candidate's, and counts on neither side.
 */
export function acceptanceRate(accepted: number, declined: number, expired: number): number | null {
  const decided = accepted + declined + expired;
  return decided === 0 ? null : Math.round((accepted / decided) * 100);
}
