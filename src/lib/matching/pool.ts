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
import { normalizeThemes } from './semantic';

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
  // The cached profile themes (#2038), in the same query — never one per person.
  profileDigest: { select: { themes: true } },
} as const;

/** Swap the digest relation for the scorer's `themes` field. */
function withThemes<T extends { profileDigest: { themes: unknown } | null }>(row: T): Omit<T, 'profileDigest'> & { themes: string[] } {
  const { profileDigest, ...rest } = row;
  return { ...rest, themes: normalizeThemes(profileDigest?.themes) };
}

/** Who is in the mentor pool — one definition, shared by the loader and the cohort pass's cap check. */
export function mentorPoolWhere(tenant: TenantWhere) {
  return withinTenant({ role: { in: ['MENTOR' as const, 'ADMIN' as const] }, isActive: true }, tenant);
}

/** Every active mentor (and admin who mentors) of the tenant, with their load. */
export async function loadMentorPool(tenant: TenantWhere): Promise<PoolMentor[]> {
  const rows = await prisma.user.findMany({
    where: mentorPoolWhere(tenant),
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
  return rows.map(({ _count, ...m }) => ({ ...withThemes(m), activeMenteeCount: _count.mentorRelations, selfSelectedCount: seats.get(m.id) ?? 0 }));
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
  return rows.map(({ menteeRelations, ...m }) => ({ ...withThemes(m), pastMentorIds: menteeRelations.map((r) => r.mentorId) }));
}

/**
 * One pair in the scorer's shape, whatever their roles (#1789): a direct
 * assignment may pair an ADMIN or even a MENTEE as the mentor (#1141), so the
 * role filters of the two loaders above do not apply. The caller has already
 * decided the pair is legitimate and in its tenant. Null when either is gone.
 */
export async function loadPairForScoring(
  menteeId: string,
  mentorId: string,
): Promise<{ mentee: PoolMentee; mentor: PoolMentor } | null> {
  const [mentee, mentor] = await Promise.all([
    prisma.user.findUnique({ where: { id: menteeId }, select: { ...personSelect, menteeRelations: { select: { mentorId: true } } } }),
    prisma.user.findUnique({
      where: { id: mentorId },
      select: {
        ...personSelect,
        mentorCapacity: true,
        acceptingMentees: true,
        selfMatchLimit: true,
        _count: { select: { mentorRelations: { where: { status: 'ACTIVE' } } } },
      },
    }),
  ]);
  if (!mentee || !mentor) return null;
  const { menteeRelations, ...me } = mentee;
  const { _count, ...mo } = mentor;
  const seats = mo.selfMatchLimit != null ? await selfSelectedCounts([mo.id]) : new Map<string, number>();
  return {
    mentee: { ...withThemes(me), pastMentorIds: menteeRelations.map((r) => r.mentorId) },
    mentor: { ...withThemes(mo), activeMenteeCount: _count.mentorRelations, selfSelectedCount: seats.get(mo.id) ?? 0 },
  };
}
