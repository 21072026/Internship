/**
 * The one writer of MatchRuleSet / MatchRule (#1783). Server-only.
 *
 * Every edit bumps `version` and replaces the rules in one transaction, so a
 * `(ruleSetId, version)` pair names exactly one configuration. Archiving sets
 * `archivedAt` and never deletes: a historic MatchDecision (#1789) keeps
 * pointing at a row that exists. At most one live default per org — setting a
 * new one clears the others in the same transaction.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { MatchRuleSetDraft } from './ruleSetSchema';

export const ruleSetSelect = {
  id: true,
  name: true,
  description: true,
  isDefault: true,
  version: true,
  archivedAt: true,
  updatedAt: true,
  rules: {
    orderBy: { sortOrder: 'asc' as const },
    select: { dimension: true, kind: true, weight: true, config: true },
  },
} satisfies Prisma.MatchRuleSetSelect;

export type RuleSetRow = Prisma.MatchRuleSetGetPayload<{ select: typeof ruleSetSelect }>;

export function serializeRuleSet(r: RuleSetRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    isDefault: r.isDefault,
    version: r.version,
    archived: r.archivedAt !== null,
    updatedAt: r.updatedAt.toISOString(),
    rules: r.rules.map((x) => ({
      dimension: x.dimension,
      kind: x.kind,
      weight: x.weight,
      config: x.config && typeof x.config === 'object' && !Array.isArray(x.config) ? (x.config as Record<string, unknown>) : {},
    })),
  };
}

const ruleRows = (orgId: string, rules: MatchRuleSetDraft['rules']) =>
  rules.map((r, i) => ({ orgId, dimension: r.dimension, kind: r.kind, weight: r.weight, config: r.config as Prisma.InputJsonValue, sortOrder: i }));

async function clearOtherDefaults(tx: Prisma.TransactionClient, orgId: string, keepId: string) {
  await tx.matchRuleSet.updateMany({ where: { orgId, isDefault: true, id: { not: keepId } }, data: { isDefault: false } });
}

export async function createRuleSet(orgId: string, draft: MatchRuleSetDraft, isDefault: boolean) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.matchRuleSet.create({
      data: { orgId, name: draft.name, description: draft.description ?? null, isDefault, rules: { create: ruleRows(orgId, draft.rules) } },
      select: { id: true },
    });
    if (isDefault) await clearOtherDefaults(tx, orgId, created.id);
    return tx.matchRuleSet.findUniqueOrThrow({ where: { id: created.id }, select: ruleSetSelect });
  });
}

/** Null when the set is not this org's or is archived. */
export async function updateRuleSet(orgId: string, id: string, draft: Partial<MatchRuleSetDraft>, isDefault?: boolean) {
  return prisma.$transaction(async (tx) => {
    const bumped = await tx.matchRuleSet.updateMany({
      where: { id, orgId, archivedAt: null },
      data: {
        ...(draft.name !== undefined ? { name: draft.name } : {}),
        ...(draft.description !== undefined ? { description: draft.description ?? null } : {}),
        ...(isDefault !== undefined ? { isDefault } : {}),
        version: { increment: 1 },
      },
    });
    if (bumped.count === 0) return null;
    if (draft.rules) {
      await tx.matchRule.deleteMany({ where: { ruleSetId: id } });
      await tx.matchRule.createMany({ data: ruleRows(orgId, draft.rules).map((r) => ({ ...r, ruleSetId: id })) });
    }
    if (isDefault) await clearOtherDefaults(tx, orgId, id);
    return tx.matchRuleSet.findUniqueOrThrow({ where: { id }, select: ruleSetSelect });
  });
}

/** Archive, never delete. Null when the set is not this org's. */
export async function archiveRuleSet(orgId: string, id: string) {
  const res = await prisma.matchRuleSet.updateMany({
    where: { id, orgId, archivedAt: null },
    data: { archivedAt: new Date(), isDefault: false },
  });
  return res.count > 0;
}
