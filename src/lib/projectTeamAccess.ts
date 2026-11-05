import 'server-only';
import type { Prisma } from '@prisma/client';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import {
  NO_CONNECTIONS,
  addableSeats,
  type TeamActor,
  type TeamConnections,
  type TeamSeat,
} from '@/lib/projectTeamRule';

// The Prisma half of #2272: it only READS the facts `projectTeamRule.ts`
// judges. Every query is narrowed to the caller's tenant, so a person of
// another tenant is never even a candidate.

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
    const own = await prisma.mentorshipRelation.findMany({
      where: withinTenant<Prisma.MentorshipRelationWhereInput>({ menteeId: actor.id, status: 'ACTIVE' }, tenant),
      select: { mentorId: true },
    });
    const mentors = new Set(own.map((r) => r.mentorId));
    if (mentors.size === 0) return { mentors, mentees: new Set() };
    const peers = await prisma.mentorshipRelation.findMany({
      where: withinTenant<Prisma.MentorshipRelationWhereInput>(
        { mentorId: { in: [...mentors] }, status: 'ACTIVE', NOT: { menteeId: actor.id } },
        tenant
      ),
      select: { menteeId: true },
    });
    return { mentors, mentees: new Set(peers.map((r) => r.menteeId)) };
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
