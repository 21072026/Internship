/**
 * Who is in a mentorship relation (#1804) — the read helpers every consumer
 * moves to over time, and the one writer of seats. Server-only (Prisma); the
 * vocabulary and the membership rule are pure in src/lib/relationShapes.ts.
 *
 * THE TRANSITION RULE: `mentorId`/`menteeId` stay the primary pair and stay
 * the truth for it — every reader that still compares those two scalars keeps
 * working unchanged. A `RelationParticipant` row with `isPrimaryPair` mirrors
 * them and grants nothing; only the seats BEYOND the pair (a group's other
 * mentees, a co-facilitator) grant membership, and only while `leftAt` is
 * null. So `isParticipant()` asks the scalars first and the seats second.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { currentMemberIds, pairSeats, type ParticipantRole } from '@/lib/relationShapes';

type Db = Prisma.TransactionClient;

export interface RelationPair {
  id: string;
  mentorId: string;
  menteeId: string;
}

/** Is `userId` in this relation now — the scalar pair or a seat nobody has left? */
export async function isParticipant(relation: RelationPair, userId: string, db: Db = prisma): Promise<boolean> {
  if (relation.mentorId === userId || relation.menteeId === userId) return true;
  const seat = await db.relationParticipant.findFirst({
    where: { relationId: relation.id, userId, leftAt: null, isPrimaryPair: false },
    select: { id: true },
  });
  return seat !== null;
}

/** Every current member's id, the pair included. */
export async function memberIdsOf(relation: RelationPair, db: Db = prisma): Promise<Set<string>> {
  const seats = await db.relationParticipant.findMany({
    where: { relationId: relation.id },
    select: { userId: true, role: true, isPrimaryPair: true, leftAt: true },
  });
  return currentMemberIds(relation, seats);
}

/**
 * Everyone who is or was in the relation, for the detail screen: the pair
 * first (from the scalars), then every other seat with its joined/left dates.
 * A left seat stays in the list — the history is the record.
 */
export async function participantsOf(relation: RelationPair, db: Db = prisma) {
  const seats = await db.relationParticipant.findMany({
    where: { relationId: relation.id, isPrimaryPair: false },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, userId: true, role: true, joinedAt: true, leftAt: true, user: { select: { id: true, fullName: true } } },
  });
  const pair = await db.user.findMany({ where: { id: { in: [relation.mentorId, relation.menteeId] } }, select: { id: true, fullName: true } });
  const name = (id: string) => pair.find((u) => u.id === id)?.fullName ?? null;
  return [
    { id: null, userId: relation.mentorId, fullName: name(relation.mentorId), role: 'MENTOR' as const, primary: true, joinedAt: null, leftAt: null },
    { id: null, userId: relation.menteeId, fullName: name(relation.menteeId), role: 'MENTEE' as const, primary: true, joinedAt: null, leftAt: null },
    ...seats.map((s) => ({ id: s.id, userId: s.userId, fullName: s.user.fullName, role: s.role, primary: false, joinedAt: s.joinedAt, leftAt: s.leftAt })),
  ];
}

/** Current mentors (the pair's mentor plus any MENTOR/FACILITATOR seat). */
export async function mentorsOf(relation: RelationPair, db: Db = prisma): Promise<string[]> {
  const seats = await db.relationParticipant.findMany({
    where: { relationId: relation.id, leftAt: null, isPrimaryPair: false, role: { in: ['MENTOR', 'FACILITATOR'] } },
    select: { userId: true },
  });
  return [...new Set([relation.mentorId, ...seats.map((s) => s.userId)])];
}

/** Current mentees (the pair's mentee plus every MENTEE seat). */
export async function menteesOf(relation: RelationPair, db: Db = prisma): Promise<string[]> {
  const seats = await db.relationParticipant.findMany({
    where: { relationId: relation.id, leftAt: null, isPrimaryPair: false, role: 'MENTEE' },
    select: { userId: true },
  });
  return [...new Set([relation.menteeId, ...seats.map((s) => s.userId)])];
}

/** The pair's two mirror seats; idempotent (the unique (relationId, userId) skips a duplicate). */
export async function writePairSeats(db: Db, relation: RelationPair): Promise<void> {
  await db.relationParticipant.createMany({
    data: pairSeats(relation).map((s) => ({ ...s, relationId: relation.id })),
    skipDuplicates: true,
  });
}

/** Seat someone beyond the pair. A person who left and comes back gets their row reopened. */
export async function addSeat(db: Db, relationId: string, userId: string, role: ParticipantRole): Promise<void> {
  await db.relationParticipant.upsert({
    where: { relationId_userId: { relationId, userId } },
    create: { relationId, userId, role, isPrimaryPair: false },
    update: { role, leftAt: null, joinedAt: new Date() },
  });
}

/** Someone leaves: `leftAt` is stamped, the row is never deleted. Returns false when there was no open seat. */
export async function leaveSeat(db: Db, relationId: string, userId: string): Promise<boolean> {
  const r = await db.relationParticipant.updateMany({
    where: { relationId, userId, leftAt: null, isPrimaryPair: false },
    data: { leftAt: new Date() },
  });
  return r.count === 1;
}
