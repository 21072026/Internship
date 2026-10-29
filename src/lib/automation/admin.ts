// The server half of /admin/automations (#1704): what the routes read and
// check, in one place. Server-only (Prisma). The vocabulary and the write-time
// gate are ./rule.ts; the dry run is ./simulate.ts.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { outcomeForStage } from '@/lib/outcomeComms';
import { readTranslations } from '@/lib/goalTemplates';
import { parseRequirementLabels } from '@/lib/documentRequirements';
import type { Locale } from '@/i18n/config';
import { MAX_RULES_PER_ORG, parseRuleInput, referencedRow, readStoredRule, type AutomationAction, type RuleInputResult } from './rule';
import { SIMULATE_DEFAULT_LIMIT, SIMULATE_MAX_LIMIT, simulateRule, type HistoryMove, type SimulationResult } from './simulate';

export interface StageOption {
  key: string;
  label: string;
  isOutcome: boolean;
}

/** The org's own stages (custom ones included), labelled in `locale`, with the outcome flag. */
export async function stageOptions(orgId: string, locale: Locale = 'en'): Promise<StageOption[]> {
  const stages = await resolvePipelineStages(orgId, locale);
  return stages.map((s) => ({ key: s.key, label: s.label || s.key, isOutcome: outcomeForStage(s.key, { isOffPath: s.isOffPath }) !== null }));
}

/** The org-owned rows an action may name, for the editor's pickers. */
export async function referenceOptions(orgId: string, locale: Locale) {
  const [tags, requirements, templates] = await Promise.all([
    prisma.tag.findMany({ where: { orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 200 }),
    prisma.documentRequirement.findMany({ where: { orgId, active: true }, select: { id: true, key: true, labels: true }, orderBy: [{ order: 'asc' }, { key: 'asc' }] }),
    prisma.projectTaskTemplate.findMany({
      where: { orgId, projectId: null, archivedAt: null },
      select: { id: true, title: true, translations: true },
      orderBy: [{ useCount: 'desc' }, { createdAt: 'asc' }],
      take: 200,
    }),
  ]);
  return {
    tags: tags.map((t) => ({ id: t.id, label: t.name })),
    documentRequirements: requirements.map((r) => ({ id: r.id, label: parseRequirementLabels(r.labels)?.[locale] ?? r.key })),
    goalTemplates: templates.map((t) => ({ id: t.id, label: readTranslations(t.translations)[locale] ?? t.title })),
  };
}

/** The ids `actions` name that are not this org's (or no longer exist). */
export async function foreignReferences(orgId: string, actions: readonly AutomationAction[]): Promise<string[]> {
  const bad: string[] = [];
  for (const action of actions) {
    const ref = referencedRow(action);
    if (!ref) continue;
    const found =
      ref.kind === 'tag'
        ? await prisma.tag.count({ where: { id: ref.id, orgId } })
        : ref.kind === 'documentRequirement'
          ? await prisma.documentRequirement.count({ where: { id: ref.id, orgId, active: true } })
          : await prisma.projectTaskTemplate.count({ where: { id: ref.id, orgId, archivedAt: null } });
    if (found === 0) bad.push(`${action.type}: ${ref.id}`);
  }
  return bad;
}

export type ValidatedRule = RuleInputResult | { ok: false; code: 'unknown_stage' | 'foreign_reference'; issues: string[] };

/** parseRuleInput() + the org checks: the stage is one of the org's, every named row is the org's. */
export async function validateRuleForOrg(orgId: string, input: unknown): Promise<ValidatedRule> {
  const stages = await stageOptions(orgId);
  const outcome = new Set(stages.filter((s) => s.isOutcome).map((s) => s.key));
  const parsed = parseRuleInput(input, (k) => outcome.has(k));
  if (!parsed.ok) return parsed;
  const keys = new Set(stages.map((s) => s.key));
  if (!keys.has(parsed.rule.stageKey)) return { ok: false, code: 'unknown_stage', issues: [`stageKey: ${parsed.rule.stageKey}`] };
  for (const c of parsed.rule.conditions) {
    if ((c.field === 'fromStage' || c.field === 'toStage') && c.value.some((k) => !keys.has(k))) {
      return { ok: false, code: 'unknown_stage', issues: [`conditions.${c.field}`] };
    }
  }
  const foreign = await foreignReferences(orgId, parsed.rule.actions);
  if (foreign.length > 0) return { ok: false, code: 'foreign_reference', issues: foreign };
  return parsed;
}

export async function ruleCount(orgId: string): Promise<number> {
  return prisma.automationRule.count({ where: { orgId } });
}
export { MAX_RULES_PER_ORG };

export const ruleSelect = {
  id: true,
  name: true,
  trigger: true,
  stageKey: true,
  conditions: true,
  actions: true,
  delayMinutes: true,
  enabled: true,
  position: true,
  lastSimulatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.AutomationRuleSelect;

/** A stored rule as JSON. `valid: false` when its JSON no longer parses (the run would be FAILED). */
export function serializeRule(row: Prisma.AutomationRuleGetPayload<{ select: typeof ruleSelect }>) {
  const stored = readStoredRule(row);
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger,
    stageKey: row.stageKey,
    conditions: stored?.conditions ?? [],
    actions: stored?.actions ?? [],
    valid: stored !== null,
    delayMinutes: row.delayMinutes,
    enabled: row.enabled,
    position: row.position,
    lastSimulatedAt: row.lastSimulatedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One of this org's rules, or null (another org's id reads as missing). */
export function findOrgRule(orgId: string, id: string) {
  return prisma.automationRule.findFirst({ where: { id, orgId }, select: ruleSelect });
}

/**
 * The dry run (#1704): the org's last `limit` real stage moves, judged by the
 * rule's own trigger and conditions. Reads only; the one write is the caller's
 * `lastSimulatedAt` stamp. Never imports an action handler (see simulate.ts).
 */
export async function simulateOrgRule(
  orgId: string,
  rule: Parameters<typeof simulateRule>[0],
  limit: number = SIMULATE_DEFAULT_LIMIT,
): Promise<SimulationResult> {
  const take = Math.min(Math.max(1, Math.floor(limit)), SIMULATE_MAX_LIMIT);
  const rows = await prisma.statusChange.findMany({
    where: { relation: { orgId } },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      relationId: true,
      fromStatus: true,
      toStatus: true,
      createdAt: true,
      relation: { select: { kind: true, companyId: true, startDate: true, mentee: { select: { fullName: true } } } },
    },
  });
  const relationIds = [...new Set(rows.map((r) => r.relationId))];
  const timeline = relationIds.length
    ? await prisma.statusChange.findMany({
        where: { relationId: { in: relationIds } },
        select: { relationId: true, toStatus: true, createdAt: true },
      })
    : [];
  const entries = new Map<string, { stage: string; at: Date }[]>();
  for (const t of timeline) {
    const list = entries.get(t.relationId) ?? [];
    list.push({ stage: t.toStatus, at: t.createdAt });
    entries.set(t.relationId, list);
  }
  const history: HistoryMove[] = rows.map((r) => ({
    id: r.id,
    relationId: r.relationId,
    from: r.fromStatus,
    to: r.toStatus,
    at: r.createdAt,
    kind: r.relation.kind,
    hasCompany: Boolean(r.relation.companyId),
    relationStart: r.relation.startDate,
    menteeName: r.relation.mentee?.fullName ?? '',
  }));
  const outcome = new Set((await stageOptions(orgId)).filter((s) => s.isOutcome).map((s) => s.key));
  return simulateRule(rule, history, entries, (k) => outcome.has(k));
}
