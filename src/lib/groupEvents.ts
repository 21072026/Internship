// Group sessions and office hours (#1856) — the ONE writer of seats.
//
// Every change to who holds a seat (register, cancel a registration, raise the
// capacity, cancel the event) runs here, inside one transaction that first
// locks the event row (`SELECT … FOR UPDATE`), so all seat changes of one
// event are serialised. The lock is the ordering; the guarded `updateMany` on
// `seatsTaken < capacity` is the correctness — even without the lock, two
// registrations for the last seat cannot both claim it. A seat a cancellation
// frees is refilled from the waitlist (oldest first) in the SAME transaction,
// so no newcomer can jump the queue between the release and the promotion.
//
// Invariant: `seatsTaken` = number of REGISTERED rows, and a free seat means
// an empty waitlist. The rules themselves are pure in groupEventRule.ts.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { notifyIfAllowed } from '@/lib/notify';
import { formatInTimeZone } from '@/lib/timezone';
import { intlLocaleFor } from '@/lib/interviewRequests';
import {
  audienceIncludesRole,
  capacityRefusal,
  registrationRefusal,
  type EventActor,
  type RegistrationRefusal,
  type RegistrationState,
} from '@/lib/groupEventRule';

type Tx = Prisma.TransactionClient;

/** How many waitlisted people one fill may promote — a capacity jump of 1000 is still bounded. */
const FILL_LIMIT = 1000;

async function lockEvent(tx: Tx, eventId: string) {
  // Raw SQL bypasses the tenant middleware: every caller has already read the
  // event through the scoped client before it gets here.
  await tx.$queryRaw`SELECT id FROM ProgramEvent WHERE id = ${eventId} FOR UPDATE`;
}

/** Claim one seat, or answer false when the event is full. One guarded UPDATE. */
async function claimSeat(tx: Tx, eventId: string): Promise<boolean> {
  const claimed = await tx.programEvent.updateMany({
    where: {
      id: eventId,
      cancelledAt: null,
      OR: [{ capacity: null }, { seatsTaken: { lt: prisma.programEvent.fields.capacity } }],
    },
    data: { seatsTaken: { increment: 1 } },
  });
  return claimed.count === 1;
}

async function releaseSeat(tx: Tx, eventId: string) {
  await tx.programEvent.updateMany({ where: { id: eventId, seatsTaken: { gt: 0 } }, data: { seatsTaken: { decrement: 1 } } });
}

/** Move waitlisted people into free seats, oldest first. Returns who was promoted. */
async function fillFromWaitlist(tx: Tx, eventId: string, now: Date): Promise<string[]> {
  const promoted: string[] = [];
  for (let i = 0; i < FILL_LIMIT; i++) {
    if (!(await claimSeat(tx, eventId))) break;
    const next = await tx.eventRegistration.findFirst({
      where: { eventId, state: 'WAITLISTED' },
      orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
      select: { id: true, userId: true },
    });
    if (!next) {
      await releaseSeat(tx, eventId);
      break;
    }
    const moved = await tx.eventRegistration.updateMany({
      where: { id: next.id, state: 'WAITLISTED' },
      data: { state: 'REGISTERED', promotedAt: now },
    });
    if (moved.count !== 1) {
      // Cannot happen under the row lock; give the seat back rather than leak it.
      await releaseSeat(tx, eventId);
      break;
    }
    promoted.push(next.userId);
  }
  return promoted;
}

export type RegisterOutcome =
  | { ok: true; state: RegistrationState; alreadyRegistered: boolean }
  | { ok: false; code: RegistrationRefusal | 'not_found' };

/**
 * Register `userId`. Past capacity they are WAITLISTED, never overbooked. An
 * existing live registration is answered as it stands (a double click is not
 * a second seat); a CANCELLED one re-joins at the back of the queue.
 */
export async function registerForEvent(eventId: string, userId: string, now = new Date()): Promise<RegisterOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const event = await tx.programEvent.findUnique({
        where: { id: eventId },
        select: { id: true, startsAt: true, durationMinutes: true, publishedAt: true, cancelledAt: true },
      });
      if (!event) return { ok: false, code: 'not_found' } as const;
      await lockEvent(tx, eventId);
      const existing = await tx.eventRegistration.findUnique({
        where: { eventId_userId: { eventId, userId } },
        select: { id: true, state: true },
      });
      if (existing && existing.state !== 'CANCELLED') {
        return { ok: true, state: existing.state as RegistrationState, alreadyRegistered: true } as const;
      }
      const refusal = registrationRefusal(event, now);
      if (refusal) return { ok: false, code: refusal } as const;

      const state: RegistrationState = (await claimSeat(tx, eventId)) ? 'REGISTERED' : 'WAITLISTED';
      const data = {
        state,
        registeredAt: now,
        promotedAt: null,
        cancelledAt: null,
        attendance: null,
        attendedAt: null,
        attendanceRecordedById: null,
      };
      if (existing) {
        const revived = await tx.eventRegistration.updateMany({ where: { id: existing.id, state: 'CANCELLED' }, data });
        if (revived.count !== 1) throw new Error('registration changed under the lock');
      } else {
        await tx.eventRegistration.create({ data: { eventId, userId, ...data } });
      }
      return { ok: true, state, alreadyRegistered: false } as const;
    });
  } catch (e) {
    // Two requests of the same person racing past the lock-free read: the
    // loser's insert hits @@unique and its whole transaction (seat included)
    // rolls back. The winner's row is the answer.
    if ((e as { code?: string }).code === 'P2002') {
      const row = await prisma.eventRegistration.findUnique({ where: { eventId_userId: { eventId, userId } }, select: { state: true } });
      if (row && row.state !== 'CANCELLED') return { ok: true, state: row.state as RegistrationState, alreadyRegistered: true };
    }
    throw e;
  }
}

export type CancelRegistrationOutcome =
  | { ok: true; wasRegistered: boolean; promoted: string[] }
  | { ok: false; code: 'not_registered' | 'event_started' };

/** Give up a place (or leave the waitlist). A freed seat goes to the first waitlisted person. */
export async function cancelRegistration(eventId: string, userId: string, now = new Date()): Promise<CancelRegistrationOutcome> {
  const result = await prisma.$transaction(async (tx) => {
    const event = await tx.programEvent.findUnique({ where: { id: eventId }, select: { startsAt: true, cancelledAt: true } });
    if (!event) return { ok: false, code: 'not_registered' } as const;
    await lockEvent(tx, eventId);
    const reg = await tx.eventRegistration.findUnique({ where: { eventId_userId: { eventId, userId } }, select: { id: true, state: true } });
    if (!reg || reg.state === 'CANCELLED') return { ok: false, code: 'not_registered' } as const;
    // After the start a "cancellation" would rewrite who was expected; the
    // host records it as attendance (LATE_CANCEL / EXCUSED) instead.
    if (now >= event.startsAt) return { ok: false, code: 'event_started' } as const;
    const moved = await tx.eventRegistration.updateMany({
      where: { id: reg.id, state: reg.state },
      data: { state: 'CANCELLED', cancelledAt: now },
    });
    if (moved.count !== 1) return { ok: false, code: 'not_registered' } as const;
    if (reg.state !== 'REGISTERED') return { ok: true, wasRegistered: false, promoted: [] as string[] } as const;
    await releaseSeat(tx, eventId);
    const promoted = event.cancelledAt ? [] : await fillFromWaitlist(tx, eventId, now);
    return { ok: true, wasRegistered: true, promoted } as const;
  });
  if (result.ok && result.promoted.length) await noticePromoted(eventId, result.promoted);
  return result;
}

/** Change the cap. Lowering below the seats given away is refused; raising promotes the waitlist. */
export async function setEventCapacity(
  eventId: string,
  capacity: number | null,
  now = new Date(),
): Promise<{ ok: true; promoted: string[] } | { ok: false; code: 'capacity_below_registered' }> {
  const result = await prisma.$transaction(async (tx) => {
    await lockEvent(tx, eventId);
    const current = await tx.programEvent.findUnique({ where: { id: eventId }, select: { seatsTaken: true, startsAt: true, cancelledAt: true } });
    if (!current) return { ok: true, promoted: [] as string[] } as const;
    const refusal = capacityRefusal(capacity, current.seatsTaken);
    if (refusal) return { ok: false, code: refusal } as const;
    await tx.programEvent.update({ where: { id: eventId }, data: { capacity } });
    const promoted = current.cancelledAt || now >= current.startsAt ? [] : await fillFromWaitlist(tx, eventId, now);
    return { ok: true, promoted } as const;
  });
  if (result.ok && result.promoted.length) await noticePromoted(eventId, result.promoted);
  return result;
}

/**
 * Call the event off. The row and every registration stay (attendance and the
 * record of who signed up keep their anchor); everyone holding a place or a
 * waitlist spot is told. Guarded on `cancelledAt: null`, so it happens once.
 */
export async function cancelEvent(eventId: string, actorId: string, now = new Date()): Promise<boolean> {
  const done = await prisma.programEvent.updateMany({
    where: { id: eventId, cancelledAt: null },
    data: { cancelledAt: now, cancelledById: actorId },
  });
  if (done.count !== 1) return false;
  const people = await prisma.eventRegistration.findMany({
    where: { eventId, state: { in: ['REGISTERED', 'WAITLISTED'] }, userId: { not: actorId } },
    select: { userId: true },
  });
  await noticeEvent(eventId, people.map((p) => p.userId), 'event.cancelled');
  return true;
}

// ── Who sees what ────────────────────────────────────────────────────────────

/** The programmes a person is in: an ACTIVE relation of theirs, on either side. */
export async function programIdsOf(userId: string): Promise<string[]> {
  const rows = await prisma.mentorshipRelation.findMany({
    where: { status: 'ACTIVE', cohortId: { not: null }, OR: [{ mentorId: userId }, { menteeId: userId }] },
    select: { cohortId: true },
    distinct: ['cohortId'],
  });
  return rows.map((r) => r.cohortId as string);
}

/**
 * The ONE "which events may this actor list" filter. Admins: every event of
 * their org. Mentors and mentees: published events whose audience includes
 * their role, open to all or to a programme they are in — plus, for anyone,
 * events they host or hold a registration for. Anything else: nothing (null).
 */
export async function visibleEventsWhere(actor: EventActor): Promise<Prisma.ProgramEventWhereInput | null> {
  if (!actor.orgId) return null;
  if (actor.role === 'ADMIN') return { orgId: actor.orgId };
  if (actor.role !== 'MENTOR' && actor.role !== 'MENTEE') return null;
  const programs = await programIdsOf(actor.userId);
  const audiences = actor.role === 'MENTOR' ? ['MENTORS', 'ALL'] : ['MENTEES', 'ALL'];
  return {
    orgId: actor.orgId,
    OR: [
      { hostId: actor.userId },
      { registrations: { some: { userId: actor.userId } }, publishedAt: { not: null } },
      {
        publishedAt: { not: null },
        audience: { in: audiences },
        OR: [{ programId: null }, { programId: { in: programs } }],
      },
    ],
  };
}

/** Is this person in the event's audience (role + programme)? The register route asks before anything else. */
export async function inAudience(
  e: { audience: string; programId: string | null },
  person: { id: string; role: string },
): Promise<boolean> {
  if (!audienceIncludesRole(e.audience, person.role)) return false;
  if (!e.programId) return true;
  return (await programIdsOf(person.id)).includes(e.programId);
}

/** Everyone the event is for, for the publish notice. Bounded: an org is a few thousand people at most. */
export async function audienceUserIds(e: { orgId: string | null; audience: string; programId: string | null; hostId: string }): Promise<string[]> {
  if (!e.orgId) return [];
  const roles = e.audience === 'ALL' ? ['MENTEE', 'MENTOR'] : e.audience === 'MENTORS' ? ['MENTOR'] : ['MENTEE'];
  const where: Prisma.UserWhereInput = { orgId: e.orgId, role: { in: roles as ('MENTEE' | 'MENTOR')[] }, isActive: true, id: { not: e.hostId } };
  if (e.programId) {
    where.OR = [
      { menteeRelations: { some: { cohortId: e.programId, status: 'ACTIVE' } } },
      { mentorRelations: { some: { cohortId: e.programId, status: 'ACTIVE' } } },
    ];
  }
  const users = await prisma.user.findMany({ where, select: { id: true }, take: 5000 });
  return users.map((u) => u.id);
}

// ── Notices ──────────────────────────────────────────────────────────────────

export function eventLinkFor(role: string, eventId: string): string {
  if (role === 'MENTEE') return `/portal/events?event=${eventId}`;
  if (role === 'ADMIN') return `/admin/events?event=${eventId}`;
  return `/mentor/events?event=${eventId}`;
}

type EventNotice = 'event.promoted' | 'event.cancelled' | 'event.published' | 'event.updated';

/** In-app, on each recipient's clock and in their language. Never throws. */
export async function noticeEvent(eventId: string, userIds: string[], kind: EventNotice) {
  if (userIds.length === 0) return;
  try {
    const event = await prisma.programEvent.findUnique({ where: { id: eventId }, select: { title: true, startsAt: true } });
    if (!event) return;
    const people = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, role: true, timezone: true, preferredLanguage: true },
    });
    for (const p of people) {
      const when = formatInTimeZone(event.startsAt, p.timezone, undefined, intlLocaleFor(p.preferredLanguage));
      await notifyIfAllowed(p.id, 'meetingReminders', kind, { title: event.title, when }, eventLinkFor(p.role, eventId));
    }
  } catch (e) {
    logger.error('Group event notice failed', { eventId, kind, error: String(e) });
  }
}

const noticePromoted = (eventId: string, userIds: string[]) => noticeEvent(eventId, userIds, 'event.promoted');

// ── What a viewer is shown ───────────────────────────────────────────────────

export const eventSelect = {
  id: true,
  orgId: true,
  programId: true,
  title: true,
  description: true,
  startsAt: true,
  timeZone: true,
  durationMinutes: true,
  capacity: true,
  seatsTaken: true,
  location: true,
  joinUrl: true,
  hostId: true,
  audience: true,
  publishedAt: true,
  cancelledAt: true,
  createdAt: true,
  host: { select: { id: true, fullName: true } },
  program: { select: { id: true, name: true } },
} satisfies Prisma.ProgramEventSelect;

export type EventRow = Prisma.ProgramEventGetPayload<{ select: typeof eventSelect }>;

export interface MyRegistration {
  state: string;
  attendance: string | null;
  attendedAt: Date | null;
}

/**
 * The one shape a client gets. The join link reaches only the people who may
 * use it — the host, an admin, a confirmed registrant — so a waitlisted or
 * merely curious person cannot walk into a capped session. No registration of
 * anyone else is in it; the participant list is the manage route's.
 */
export function eventView(e: EventRow, opts: { manage: boolean; mine: MyRegistration | null; waitlisted: number }) {
  const { joinUrl, orgId: _orgId, ...rest } = e;
  const mayJoin = opts.manage || opts.mine?.state === 'REGISTERED';
  return {
    ...rest,
    joinUrl: mayJoin ? joinUrl : null,
    hasJoinUrl: Boolean(joinUrl),
    waitlisted: opts.waitlisted,
    canManage: opts.manage,
    myRegistration: opts.mine,
  };
}
