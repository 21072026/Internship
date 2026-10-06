// Booking guardrails (#2003), server-only: the ONE place a mentor's policy is
// enforced. Every write path calls `findPolicyViolation` — meeting create and
// move inside the #1995 lock (src/lib/busyWindows.ts `bookWithoutConflict`),
// the meeting-request POST, and the accept branch. The judging is the pure
// src/lib/bookingPolicyRule.ts.
//
// WHO IS BOUND
//   • The mentor's own bookings are exempt — a mentor scheduling with their own
//     mentee is not demand, and these are their own lines to cross.
//   • Everyone else (a mentee asking, an admin scheduling) is bound; an ADMIN
//     may book over a rule with `force: true`, which is recorded
//     (`meeting.forcePolicy`). What must never happen is a mentor silently
//     exceeding a limit they set.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { busyWindows } from '@/lib/busyWindows';
import { checkPolicy, isEmptyPolicy, periodBounds, type BookingPolicy, type PolicyViolation } from '@/lib/bookingPolicyRule';

type Db = Prisma.TransactionClient | typeof prisma;

const POLICY_SELECT = { minNoticeMinutes: true, bufferMinutes: true, maxPerWeek: true, maxPerMonth: true, defaultSlotMinutes: true } as const;

export async function loadBookingPolicy(db: Db, mentorId: string): Promise<BookingPolicy | null> {
  const row = await db.mentorBookingPolicy.findUnique({ where: { mentorId }, select: POLICY_SELECT });
  return row && !isEmptyPolicy(row) ? row : null;
}

/** The mentor's own bookings never trip their own rules. */
export function policyExempt(actor: { id: string }, mentorId: string): boolean {
  return actor.id === mentorId;
}

/**
 * The bookings of this mentor in [from, to) that a cap counts. A bulk session
 * is one row per invitee sharing a `batchKey` — one call for the mentor, so it
 * counts once.
 */
async function countMeetings(db: Db, mentorId: string, from: Date, to: Date, excludeMeetingIds: string[], excludeBatchKey?: string): Promise<number> {
  const rows = await db.meeting.findMany({
    where: {
      status: { not: 'CANCELLED' },
      scheduledAt: { gte: from, lt: to },
      relation: { mentorId },
      ...(excludeMeetingIds.length ? { id: { notIn: excludeMeetingIds } } : {}),
      // The session being booked right now is the candidate, not history.
      ...(excludeBatchKey ? { AND: [{ OR: [{ batchKey: null }, { batchKey: { not: excludeBatchKey } }] }] } : {}),
    },
    select: { id: true, batchKey: true },
  });
  return new Set(rows.map((r) => r.batchKey ?? r.id)).size;
}

/**
 * The first of the mentor's rules this booking breaks, or null. `excludeMeetingIds`
 * is the meeting being moved: it neither counts toward a cap nor stands in its
 * own buffer.
 */
export async function findPolicyViolation(
  db: Db,
  input: { mentorId: string; start: Date; end: Date; now?: Date; excludeMeetingIds?: string[]; excludeBatchKey?: string; policy?: BookingPolicy | null },
): Promise<PolicyViolation | null> {
  const policy = input.policy === undefined ? await loadBookingPolicy(db, input.mentorId) : input.policy;
  if (!policy) return null;
  const now = input.now ?? new Date();
  const exclude = input.excludeMeetingIds ?? [];
  const mentor = await db.user.findUnique({ where: { id: input.mentorId }, select: { timezone: true } });
  const week = periodBounds(input.start, mentor?.timezone, 'week');
  const month = periodBounds(input.start, mentor?.timezone, 'month');
  const buffer = (policy.bufferMinutes ?? 0) * 60_000;
  const [weekCount, monthCount, busy] = await Promise.all([
    policy.maxPerWeek ? countMeetings(db, input.mentorId, week.start, week.end, exclude, input.excludeBatchKey) : Promise.resolve(0),
    policy.maxPerMonth ? countMeetings(db, input.mentorId, month.start, month.end, exclude, input.excludeBatchKey) : Promise.resolve(0),
    buffer
      ? busyWindows(db, [input.mentorId], new Date(input.start.getTime() - buffer), new Date(input.end.getTime() + buffer), { excludeMeetingIds: exclude, excludeBatchKey: input.excludeBatchKey })
      : Promise.resolve([]),
  ]);
  return checkPolicy(policy, { start: input.start, end: input.end, now, timezone: mentor?.timezone, weekCount, monthCount, busy });
}

export interface PolicyBody {
  error: string;
  code: 'policy';
  rule: PolicyViolation['rule'];
  limit: number;
  windowStart: string;
}

export function policyBody(v: PolicyViolation): PolicyBody {
  return { error: 'This booking breaks the mentor’s booking rules', code: 'policy', ...v };
}

/** An admin booked over a mentor's rule on purpose — never silent (#2003). */
export async function recordPolicyOverride(actorId: string, meetingId: string, v: PolicyViolation): Promise<void> {
  await prisma.auditLog
    .create({ data: { actorId, action: 'meeting.forcePolicy', targetId: meetingId, detail: JSON.stringify(v) } })
    .catch(() => {});
}
