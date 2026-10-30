/**
 * The real loaders of the cohort pass (#1794). Server-only (Prisma); each one
 * is a single query over the whole intake. The pass itself is `cohortPass.ts`.
 *
 * Who is in scope: the tenant's active MENTEEs who have no ACTIVE relation —
 * the people waiting for a mentor — narrowed to `menteeIds` when the caller
 * names them. A mentee who already has an active mentor is never proposed one
 * (one active mentor per mentee, #419), even when named. A cohort has no
 * membership of its own before a relation exists, so the round's cohort is
 * where the published pairs will land (#1796), not a membership filter here —
 * but its eligibility rules are (#1945): an ineligible mentee is not in scope.
 */

import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { loadMentees, loadMentorPool, mentorPoolWhere, type PoolMentee, type PoolMentor } from './pool';
import { resolveRuleSet } from './ruleSet';
import { skillGraphsFor, skillIdsByUser } from './skillContext';
import type { CohortPassLoaders } from './cohortPass';
import { eligibleUserIds } from '@/lib/eligibility';
import { notBenched } from '@/lib/participantState';

export function cohortPassLoaders(opts: {
  tenant: TenantWhere;
  orgId: string | null;
  locale: string;
  menteeIds?: readonly string[];
  /** The round's programme (#1945): only mentees eligible for it are proposed. */
  programId?: string | null;
}): CohortPassLoaders<PoolMentee, PoolMentor> {
  const { tenant, orgId, locale } = opts;
  return {
    // Eligibility (#1945) filters BEFORE scoring, so a round never proposes
    // someone who could not be enrolled — the same evaluator the routes ask.
    menteeIds: async (limit) =>
      eligibleUserIds(orgId, opts.programId ?? null, (
        await prisma.user.findMany({
          where: withinTenant(
            {
              role: 'MENTEE' as const,
              isActive: true,
              // A benched mentee is not proposed (#1778).
              ...notBenched(),
              menteeRelations: { none: { status: 'ACTIVE' as const } },
              ...(opts.menteeIds ? { id: { in: [...opts.menteeIds] } } : {}),
            },
            tenant,
          ),
          select: { id: true },
          orderBy: { id: 'asc' },
          take: limit,
        })
      ).map((r) => r.id)),
    mentorCount: () => prisma.user.count({ where: mentorPoolWhere(tenant) }),
    mentees: (ids) => loadMentees(tenant, ids),
    mentors: () => loadMentorPool(tenant),
    skillIds: (ids) => skillIdsByUser(ids),
    preferences: async (ids) => {
      const out = new Map<string, { preferredField: string | null; preferredLanguages: unknown }>();
      if (ids.length === 0) return out;
      const rows = await prisma.mentorshipRequest.findMany({
        where: { menteeId: { in: [...ids] }, status: 'PENDING' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { menteeId: true, preferredField: true, preferredLanguages: true },
      });
      // The newest pending request speaks for the mentee, as on the queue.
      for (const r of rows) if (!out.has(r.menteeId)) out.set(r.menteeId, r);
      return out;
    },
    skillGraphs: (menteeSkillIds) => skillGraphsFor(orgId, menteeSkillIds, locale),
    ruleSet: () => resolveRuleSet(orgId),
  };
}
