import 'server-only';
import type { Prisma } from '@prisma/client';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import {
  NO_CONNECTIONS,
  menteeConnectionsFromSeats,
  type RelationSeat,
  addableSeats,
  type TeamActor,
  type TeamConnections,
  type TeamSeat,
} from '@/lib/projectTeamRule';

// The Prisma half of #2272: it only READS the facts `projectTeamRule.ts`
// judges. Every query is narrowed to the caller's tenant, so a person of
// another tenant is never even a candidate.

const MENTOR_SIDE = ['MENTOR', 'FACILITATOR'] as const;
const PERSON = { select: { id: true, orgId: true, isActive: true, participantState: true } } as const;
const RELATION_SEATS = {
  id: true,
  status: true,
  orgId: true,
  mentor: PERSON,
  mentee: PERSON,
  participants: {
    where: { isPrimaryPair: false },
    select: { userId: true, role: true, leftAt: true, user: PERSON },
  },
} as const;

type RelationRow = Prisma.MentorshipRelationGetPayload<{ select: typeof RELATION_SEATS }>;
type Person = RelationRow['mentor'];

/** Every seat of one relation: the primary pair, then the group seats beyond it. */
function seatsOf(r: RelationRow): RelationSeat[] {
  const seat = (p: Person, side: RelationSeat['side'], leftAt: Date | null): RelationSeat => ({
    relationId: r.id,
    relationStatus: r.status,
    relationOrgId: r.orgId,
    userId: p.id,
    userOrgId: p.orgId,
    userActive: p.isActive,
    userState: p.participantState,
    side,
    leftAt,
  });
  return [
    seat(r.mentor, 'MENTOR', null),
    seat(r.mentee, 'MENTEE', null),
    ...r.participants
      .filter((p) => p.role === 'MENTEE' || (MENTOR_SIDE as readonly string[]).includes(p.role))
      .map((p) => seat(p.user, p.role === 'MENTEE' ? 'MENTEE' : 'MENTOR', p.leftAt)),
  ];
}

export async function loadTeamProject(id: string) {
  return prisma.project.findUnique({
    where: { id },
    select: { id: true, name: true, ownerUserId: true, members: { select: { userId: true, role: true } } },
  });
}

/** The actor's mentorship connections (see `TeamConnections`). */
export async function loadTeamConnections(session: Session): Promise<TeamConnections> {
  const actor = session.user;
  const tenant = await tenantWhere(session);
  if (actor.role === 'MENTOR') {
    const rows = await prisma.mentorshipRelation.findMany({
      where: withinTenant<Prisma.MentorshipRelationWhereInput>({ mentorId: actor.id }, tenant),
      select: { menteeId: true },
    });
    return { mentors: new Set(), mentees: new Set(rows.map((r) => r.menteeId)) };
  }
  if (actor.role === 'MENTEE') {
    // Seats, not scalars (#3584): a group relation keeps its extra members in
    // RelationParticipant. The queries narrow to the tenant and to live rows;
    // `menteeConnectionsFromSeats()` re-judges every seat (left, ended, benched,
    // inactive, other org) so the rule never rests on the query alone.
    const org = { orgId: resolveOrgId(session) ?? null, defaultOrgId: await defaultOrgId() };
    const own = await prisma.mentorshipRelation.findMany({
      where: withinTenant<Prisma.MentorshipRelationWhereInput>(
        {
          status: 'ACTIVE',
          OR: [
            { menteeId: actor.id },
            { participants: { some: { userId: actor.id, role: 'MENTEE', leftAt: null, isPrimaryPair: false } } },
          ],
        },
        tenant
      ),
      select: RELATION_SEATS,
    });
    const ownSeats = own.flatMap(seatsOf);
    const mentorIds = [...menteeConnectionsFromSeats(actor.id, ownSeats, org).mentors];
    if (mentorIds.length === 0) return { mentors: new Set(), mentees: new Set() };
    const led = await prisma.mentorshipRelation.findMany({
      where: withinTenant<Prisma.MentorshipRelationWhereInput>(
        {
          status: 'ACTIVE',
          id: { notIn: own.map((r) => r.id) },
          OR: [
            { mentorId: { in: mentorIds } },
            {
              participants: {
                some: { userId: { in: mentorIds }, role: { in: [...MENTOR_SIDE] }, leftAt: null, isPrimaryPair: false },
              },
            },
          ],
        },
        tenant
      ),
      select: RELATION_SEATS,
    });
    return menteeConnectionsFromSeats(actor.id, [...ownSeats, ...led.flatMap(seatsOf)], org);
  }
  return NO_CONNECTIONS;
}

/** One user of the caller's tenant, or null — another tenant's id is a missing one. */
export async function loadTeamTarget(session: Session, userId: string) {
  return prisma.user.findFirst({
    where: withinTenant({ id: userId }, await tenantWhere(session)),
    select: { id: true, role: true, isActive: true },
  });
}

export interface TeamCandidate {
  id: string;
  fullName: string;
  role: string;
  seats: TeamSeat[];
}

/**
 * The people a MENTOR or MENTEE manager may add, not yet on the team — every
 * row passed through `addableSeats()`, the same call the write makes. An ADMIN
 * is not served here: their picker is `/api/users`, which applies the admin
 * tier's own program scope (#1567) — this list must not widen it.
 */
export async function listTeamCandidates(
  session: Session,
  memberIds: ReadonlySet<string>
): Promise<TeamCandidate[]> {
  const actor: TeamActor = { id: session.user.id, role: session.user.role };
  if (actor.role !== 'MENTOR' && actor.role !== 'MENTEE') return [];
  const connections = await loadTeamConnections(session);
  const or: Prisma.UserWhereInput[] =
    actor.role === 'MENTOR'
      ? [{ role: { in: ['MENTOR', 'ADMIN'] } }, { id: { in: [...connections.mentees] } }]
      : [{ id: { in: [...connections.mentors, ...connections.mentees] } }];
  const users = await prisma.user.findMany({
    where: withinTenant<Prisma.UserWhereInput>({ isActive: true, OR: or }, await tenantWhere(session)),
    select: { id: true, fullName: true, role: true, isActive: true },
    orderBy: { fullName: 'asc' },
  });
  return users
    .filter((u) => !memberIds.has(u.id))
    .map((u) => ({ id: u.id, fullName: u.fullName, role: u.role, seats: addableSeats(actor, u, connections) }))
    .filter((u) => u.seats.length > 0);
}
