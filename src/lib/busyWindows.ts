// Who is busy when (#1995) — server-only. The arithmetic is
// src/lib/busyWindowsRule.ts (pure, unit-tested); this file reads the rows.
//
// BUSY means TAKING PART, not having clicked "schedule": a person is busy for
//   • a Meeting of a relation they are the mentor or the mentee of, or of a
//     project they are a member of — unless it was cancelled, and only until
//     it ended if somebody ended it early;
//   • every occurrence of an ACTIVE recurring series of their relation or of a
//     project they belong to — expanded from the rule, because recurring
//     meetings are not stored as rows (src/lib/meetingSeriesOccurrences.ts).
// An admin who schedules one session for twenty pairs is the organiser of all
// twenty rows and the participant of none, so their own bookings never collide
// with each other.
//
// THE GUARD: `bookWithoutConflict` locks the participants' User rows
// (SELECT … FOR UPDATE) inside one transaction, checks, and only then writes.
// Two people booking the same mentor in the same second are serialised: one
// meeting, one 409 — never two meetings.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { meetingEnd, meetingDurationMinutes, MAX_MEETING_MINUTES } from '@/lib/meetingDuration';
import { ruleOccurrences, SERIES_RULE_SELECT } from '@/lib/meetingSeriesOccurrences';
import { firstConflict, overlaps, type BusyWindow, type Window } from '@/lib/busyWindowsRule';

type Db = Prisma.TransactionClient | typeof prisma;

const LOOKBACK_MS = MAX_MEETING_MINUTES * 60_000;

function participantWhere(ids: string[]) {
  return {
    OR: [
      { relation: { OR: [{ mentorId: { in: ids } }, { menteeId: { in: ids } }] } },
      { project: { members: { some: { userId: { in: ids } } } } },
    ],
  };
}

/** Every window in [from, to) that any of `userIds` takes part in. */
export async function busyWindows(
  db: Db,
  userIds: string[],
  from: Date,
  to: Date,
  opts: { excludeMeetingIds?: string[]; excludeBatchKey?: string } = {},
): Promise<BusyWindow[]> {
  if (userIds.length === 0) return [];
  // A meeting that started up to a working day before `from` may still be running.
  const since = new Date(from.getTime() - LOOKBACK_MS);
  const [meetings, series] = await Promise.all([
    db.meeting.findMany({
      where: {
        status: { not: 'CANCELLED' },
        scheduledAt: { gte: since, lt: to },
        ...(opts.excludeMeetingIds?.length ? { id: { notIn: opts.excludeMeetingIds } } : {}),
        // The other rows of the session being booked right now (one bulk
        // schedule = one room): a mentor's group call does not collide with itself.
        // Spelled with OR because `{ not: x }` alone would also drop NULL keys.
        ...(opts.excludeBatchKey ? { AND: [{ OR: [{ batchKey: null }, { batchKey: { not: opts.excludeBatchKey } }] }] } : {}),
        ...participantWhere(userIds),
      },
      select: { title: true, scheduledAt: true, durationMinutes: true, endedAt: true },
    }),
    db.meetingSeries.findMany({
      where: { active: true, ...participantWhere(userIds) },
      select: { title: true, durationMinutes: true, ...SERIES_RULE_SELECT },
    }),
  ]);
  const windows: BusyWindow[] = [];
  for (const m of meetings) {
    if (!m.scheduledAt) continue;
    const planned = meetingEnd(m.scheduledAt, m);
    const end = m.endedAt && m.endedAt < planned ? m.endedAt : planned;
    windows.push({ start: m.scheduledAt, end, title: m.title });
  }
  for (const s of series) {
    const minutes = meetingDurationMinutes(s);
    for (const at of ruleOccurrences(s, since, to)) {
      windows.push({ start: at, end: new Date(at.getTime() + minutes * 60_000), title: s.title });
    }
  }
  const range: Window = { start: from, end: to };
  return windows.filter((w) => overlaps(w, range));
}

/** The first thing `candidate` collides with for any of `userIds`, or null. */
export async function findConflict(
  db: Db,
  userIds: string[],
  candidate: Window,
  opts: { excludeMeetingIds?: string[]; excludeBatchKey?: string } = {},
): Promise<BusyWindow | null> {
  return firstConflict(candidate, await busyWindows(db, userIds, candidate.start, candidate.end, opts));
}

export interface Viewer {
  id: string;
  role: string;
}

/**
 * `findConflict` as answered to a particular caller. The 409 names what is in
 * the way — but only to somebody who takes part in it, or an admin. A mentee
 * asking for their mentor's Tuesday learns it is taken, not that it is taken by
 * another mentee's "salary negotiation".
 */
export async function findConflictFor(
  db: Db,
  viewer: Viewer,
  userIds: string[],
  candidate: Window,
  opts: { excludeMeetingIds?: string[]; excludeBatchKey?: string } = {},
): Promise<BusyWindow | null> {
  const conflict = await findConflict(db, userIds, candidate, opts);
  if (!conflict || viewer.role === 'ADMIN') return conflict;
  const own = userIds.includes(viewer.id) ? await findConflict(db, [viewer.id], candidate, opts) : null;
  return own ?? { start: conflict.start, end: conflict.end, title: '' };
}

/** Serialise every booking that involves these people until the transaction ends. */
export async function lockParticipants(tx: Prisma.TransactionClient, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM \`User\` WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`;
}

export interface ConflictBody {
  error: string;
  code: 'conflict';
  /** `title` is '' when the caller may not see what it is (see findConflictFor). */
  conflictsWith: { title: string; startsAt: string };
}

export function conflictBody(conflict: BusyWindow): ConflictBody {
  return { error: 'This time collides with another meeting', code: 'conflict', conflictsWith: { title: conflict.title, startsAt: conflict.start.toISOString() } };
}

/**
 * Lock the participants, check, and write — in one transaction. Returns the
 * write's result, or what is in the way when `force` is not set: a collision,
 * or whatever `extraCheck` refuses (a mentor's booking rules, #2003 — passed in
 * rather than imported, so this file stays below src/lib/bookingPolicy.ts).
 */
export async function bookWithoutConflict<T, R = never>(
  opts: {
    viewer: Viewer;
    userIds: string[];
    window: Window;
    force?: boolean;
    excludeMeetingIds?: string[];
    excludeBatchKey?: string;
    extraCheck?: (tx: Prisma.TransactionClient) => Promise<R | null>;
  },
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<
  | { ok: true; result: T; forcedOver: BusyWindow | null; forcedRule: R | null }
  | { ok: false; conflict: BusyWindow; refused?: undefined }
  | { ok: false; conflict?: undefined; refused: R }
> {
  return prisma.$transaction(async (tx) => {
    await lockParticipants(tx, opts.userIds);
    const conflict = await findConflictFor(tx, opts.viewer, opts.userIds, opts.window, { excludeMeetingIds: opts.excludeMeetingIds, excludeBatchKey: opts.excludeBatchKey });
    if (conflict && !opts.force) return { ok: false as const, conflict };
    const refused = opts.extraCheck ? await opts.extraCheck(tx) : null;
    if (refused && !opts.force) return { ok: false as const, refused };
    return { ok: true as const, result: await write(tx), forcedOver: conflict, forcedRule: refused };
  });
}

/** A booking made over a collision on purpose — never silent (#1995). */
export async function recordForcedBooking(actorId: string, meetingId: string, over: BusyWindow): Promise<void> {
  await prisma.auditLog
    .create({ data: { actorId, action: 'meeting.forceConflict', targetId: meetingId, detail: JSON.stringify({ over: over.title, overStartsAt: over.start.toISOString() }) } })
    .catch(() => {});
}
