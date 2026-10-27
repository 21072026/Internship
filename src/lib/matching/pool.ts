/**
 * The people a match is scored between, loaded once in the scorer's input
 * shape (#1783, reused by mentor-suggest #1787). Server-only (Prisma).
 *
 * Both sides are the caller's tenant only — pass the TenantWhere the route
 * already resolved. Nothing here writes.
 */

import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import type { MatchMentee, MatchMentor } from './dimensions';
import { selfSelectedCounts } from '@/lib/selfMatchSeats';

export type PoolMentor = MatchMentor & { fullName: string };
export type PoolMentee = MatchMentee & { fullName: string };

const personSelect = {
  id: true,
  fullName: true,
  skills: true,
  languages: true,
  department: true,
  university: true,
  city: true,
  timezone: true,
  interests: true,
  targetPosition: true,
  managerId: true,
} as const;

/** Every active mentor (and admin who mentors) of the tenant, with their load. */
export async function loadMentorPool(tenant: TenantWhere): Promise<PoolMentor[]> {
  const rows = await prisma.user.findMany({
    where: withinTenant({ role: { in: ['MENTOR' as const, 'ADMIN' as const] }, isActive: true }, tenant),
    select: {
      ...personSelect,
      mentorCapacity: true,
      acceptingMentees: true,
      selfMatchLimit: true,
      _count: { select: { mentorRelations: { where: { status: 'ACTIVE' } } } },
    },
  });
  // Seats only matter for a mentor who set a limit (#1808).
  const seats = await selfSelectedCounts(rows.filter((r) => r.selfMatchLimit != null).map((r) => r.id));
  return rows.map(({ _count, ...m }) => ({ ...m, activeMenteeCount: _count.mentorRelations, selfSelectedCount: seats.get(m.id) ?? 0 }));
}

/**
 * Mentees by id, each with every mentor they were ever paired with (the
 * previousPairing dimension). Ids outside the tenant, or not MENTEEs, are
 * simply absent from the result.
 */
export async function loadMentees(tenant: TenantWhere, ids: readonly string[]): Promise<PoolMentee[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.user.findMany({
    where: withinTenant({ id: { in: [...ids] }, role: 'MENTEE' as const }, tenant),
    select: { ...personSelect, menteeRelations: { select: { mentorId: true } } },
  });
  return rows.map(({ menteeRelations, ...m }) => ({ ...m, pastMentorIds: menteeRelations.map((r) => r.mentorId) }));
}
