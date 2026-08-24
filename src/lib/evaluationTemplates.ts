// Per-tenant evaluation-criteria resolution (#822). Server-only (reads the DB).
// The pure shape + defaults live in src/lib/evaluation.ts (client-safe); this
// module only adds the DB-backed resolver, mirroring what
// src/lib/pipelineStages.ts does for #747's pipeline stages.
//
// Behavior-preserving: an org with no EvaluationTemplate rows falls back to the
// built-in 4+4 criteria, so every existing installation is unchanged.

import { prisma } from './prisma';
import {
  ALL_CRITERIA,
  defaultCriteria,
  type EvaluationScope,
  type ResolvedCriterion,
} from './evaluation';

export { defaultCriteria, type ResolvedCriterion };

const toResolved = (rows: { key: string; labels: unknown; order: number; active: boolean }[]): ResolvedCriterion[] =>
  rows.map((r) => ({
    key: r.key,
    order: r.order,
    labels: (r.labels && typeof r.labels === 'object' ? (r.labels as Record<string, string>) : {}) ?? {},
    active: r.active,
  }));

/**
 * The org's active template for a scope, or null when it uses the built-ins.
 * `includeInactive` is for rendering history: a retired criterion still has to
 * show its label on the evaluations that were scored against it.
 */
async function activeTemplate(orgId: string | null | undefined, scope: EvaluationScope) {
  if (!orgId) return null;
  return prisma.evaluationTemplate.findFirst({
    where: { orgId, scope, active: true },
    orderBy: { createdAt: 'desc' },
    include: { criteria: { orderBy: { order: 'asc' } } },
  });
}

/** What the form should ask for: the org's active criteria, else the built-ins. */
export async function resolveCriteria(
  orgId: string | null | undefined,
  scope: EvaluationScope
): Promise<ResolvedCriterion[]> {
  const tpl = await activeTemplate(orgId, scope);
  const rows = tpl?.criteria.filter((c) => c.active) ?? [];
  return rows.length > 0 ? toResolved(rows) : defaultCriteria(scope);
}

/** The template to stamp on a new evaluation, or null for the built-in rubric. */
export async function resolveTemplateId(
  orgId: string | null | undefined,
  scope: EvaluationScope
): Promise<string | null> {
  const tpl = await activeTemplate(orgId, scope);
  return tpl && tpl.criteria.some((c) => c.active) ? tpl.id : null;
}

/**
 * Every key a score may carry, for server-side validation. The built-ins stay
 * in the set even when a template exists: a form rendered a moment before an
 * admin swapped the framework must not fail on submit, and an orphaned key is
 * a display problem, not a security one.
 */
export async function allowedCriterionKeys(orgId: string | null | undefined): Promise<Set<string>> {
  const keys = new Set<string>(ALL_CRITERIA);
  if (!orgId) return keys;
  const rows = await prisma.evaluationCriterion.findMany({
    where: { template: { orgId } },
    select: { key: true },
  });
  for (const r of rows) keys.add(r.key);
  return keys;
}

/**
 * The criteria each of a set of templates defined — including retired ones —
 * so historical evaluations render with the labels of their own era. Keyed by
 * template id; callers fall back to the built-ins for a null templateId.
 */
export async function criteriaByTemplate(
  templateIds: string[]
): Promise<Record<string, ResolvedCriterion[]>> {
  const ids = [...new Set(templateIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const rows = await prisma.evaluationCriterion.findMany({
    where: { templateId: { in: ids } },
    orderBy: { order: 'asc' },
  });
  const out: Record<string, ResolvedCriterion[]> = {};
  for (const r of rows) {
    (out[r.templateId] ??= []).push(...toResolved([r]));
  }
  return out;
}

/**
 * Both scopes' custom criteria for a tenant, or null per scope when it uses the
 * built-ins. Fed to the client provider so a custom framework renders with the
 * tenant's own wording while built-in labels stay localized on the client.
 */
export async function resolveCustomCriteria(
  orgId: string | null | undefined
): Promise<Record<EvaluationScope, ResolvedCriterion[]> | null> {
  if (!orgId) return null;
  const templates = await prisma.evaluationTemplate.findMany({
    where: { orgId, active: true },
    orderBy: { createdAt: 'desc' },
    include: { criteria: { where: { active: true }, orderBy: { order: 'asc' } } },
  });
  if (templates.length === 0) return null;
  const out = { MENTEE: [] as ResolvedCriterion[], MENTOR: [] as ResolvedCriterion[] };
  for (const scope of ['MENTEE', 'MENTOR'] as const) {
    // Newest active template wins, same rule activeTemplate() applies.
    const tpl = templates.find((t) => t.scope === scope && t.criteria.length > 0);
    if (tpl) out[scope] = toResolved(tpl.criteria);
  }
  return out.MENTEE.length === 0 && out.MENTOR.length === 0 ? null : out;
}
