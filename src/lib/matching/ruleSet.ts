/**
 * resolveRuleSet(orgId) — the rule set an org's matches are scored with
 * (#1781). Server-only (Prisma); the scorer itself is the pure ./score.ts.
 *
 * The org's newest non-archived default set wins. No org, no set, or a set
 * with no rules → the built-in DEFAULT_RULE_SET, which ranks exactly as
 * mentor-suggest did before #1781.
 */

import { prisma } from '@/lib/prisma';
import { DEFAULT_RULE_SET, type MatchRuleSetInput } from './score';

export async function resolveRuleSet(orgId: string | null | undefined): Promise<MatchRuleSetInput> {
  if (!orgId) return DEFAULT_RULE_SET;
  const set = await prisma.matchRuleSet.findFirst({
    where: { orgId, isDefault: true, archivedAt: null },
    orderBy: { updatedAt: 'desc' },
    include: { rules: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!set || set.rules.length === 0) return DEFAULT_RULE_SET;
  return {
    id: set.id,
    name: set.name,
    version: set.version,
    rules: set.rules.map((r) => ({
      dimension: r.dimension,
      kind: r.kind,
      weight: r.weight,
      config: r.config && typeof r.config === 'object' && !Array.isArray(r.config) ? (r.config as Record<string, unknown>) : {},
    })),
  };
}
