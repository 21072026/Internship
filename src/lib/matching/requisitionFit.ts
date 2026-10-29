/**
 * scoreFit() — how well one candidate fits one requisition (#2042).
 *
 * PURE and provider-free: no Prisma, no AI, no clock. It is the ranking layer
 * on top of the one "who matches this requisition" rule
 * (src/lib/requisitionMatchRule.ts, #1401) — that rule still decides WHO is a
 * match; this decides the ORDER and explains it. It returns the same
 * `{ score, breakdown[] }` shape as `scoreMatch()` (#1781, ./score.ts) so one
 * component renders both.
 *
 * COMPLIANCE (EU AI Act high-risk / NYC LL144 — read #2042 before changing):
 *   · It ranks; a person decides. Nothing reads a score to reject, filter out,
 *     advance or move anybody — a low score only orders a list.
 *   · The inputs are job-related facts only: skills, the target position, the
 *     city against the role's city / work mode, and how far along the
 *     programme pipeline the candidate is. Age, gender, nationality, photo,
 *     name — and anything inferred from them — are NOT fields of
 *     `FitCandidate`, so they cannot become inputs by accident. The unit test
 *     pins the field list.
 *   · `ruleSetVersion` travels with every score and is persisted with it
 *     (RequisitionFit), so a past ranking can be explained months later.
 *     Change a weight or a dimension → bump the version.
 *
 * Arithmetic: each APPLICABLE dimension contributes `100 × weight × ratio /
 * Σ applicable weight`, so the contributions sum to the score (0-100). A
 * dimension with nothing to compare (the role names no city, the candidate has
 * no target position) is not applicable: it shows in the breakdown with 0
 * points and its weight is spread over the others, so a missing field neither
 * punishes nor rewards anybody.
 */

import { REQUISITION_ADJACENT_MIN_WEIGHT, skillOverlap, type SkillEdgeRow } from '@/lib/skillTaxonomyRule';
import type { MatchBreakdownEntry } from './types';

export const REQUISITION_FIT_RULESET_VERSION = 'requisition-fit/1';

/** The dimensions and their weights. Changing one is a new `REQUISITION_FIT_RULESET_VERSION`. */
export const REQUISITION_FIT_WEIGHTS = Object.freeze({
  requiredSkills: 50,
  niceSkills: 15,
  stage: 15,
  title: 10,
  location: 10,
});

export type FitDimension = keyof typeof REQUISITION_FIT_WEIGHTS;

export interface FitRequisition {
  title: string;
  /** Canonical skill ids the role REQUIRES (`RequisitionSkill.required`). */
  requiredSkillIds: readonly string[];
  /** Canonical skill ids that are nice to have (`required = false`). */
  niceSkillIds?: readonly string[];
  city?: string | null;
  /** 'REMOTE' makes the city irrelevant. */
  workMode?: string | null;
}

/**
 * Everything the score may read about a candidate. Deliberately NOT a `User`:
 * a field that is not listed here cannot become an input.
 */
export interface FitCandidate {
  id: string;
  targetPosition: string | null;
  skillIds: readonly string[];
  city?: string | null;
  /**
   * How far along the programme's on-path stages the candidate's active
   * relation is, 0 (first stage) … 1 (last). Null = no active relation or an
   * off-path stage: not applicable. Computed by the caller from the org's
   * resolved stages, so no stage key is named here.
   */
  stageProgress?: number | null;
}

export interface FitScore {
  /** 0-100. */
  score: number;
  breakdown: MatchBreakdownEntry[];
  ruleSetVersion: string;
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim();

interface Evaluated {
  dimension: FitDimension;
  applicable: boolean;
  ratio: number;
  detail: string[];
}

function evaluate(req: FitRequisition, cand: FitCandidate, edges: readonly SkillEdgeRow[]): Evaluated[] {
  const required = Array.from(new Set(req.requiredSkillIds));
  const nice = Array.from(new Set(req.niceSkillIds ?? [])).filter((id) => !required.includes(id));
  const req1 = skillOverlap(required, cand.skillIds, edges, REQUISITION_ADJACENT_MIN_WEIGHT);
  const nice1 = skillOverlap(nice, cand.skillIds, edges, REQUISITION_ADJACENT_MIN_WEIGHT);
  const target = norm(cand.targetPosition);
  const title = norm(req.title);
  const remote = norm(req.workMode) === 'remote';
  const roleCity = norm(req.city);
  const stage = cand.stageProgress;
  return [
    {
      dimension: 'requiredSkills',
      applicable: required.length > 0,
      ratio: required.length > 0 ? Math.min(1, req1.score / required.length) : 0,
      detail: [...req1.direct, ...req1.adjacent.map((a) => a.skillId)],
    },
    {
      dimension: 'niceSkills',
      applicable: nice.length > 0,
      ratio: nice.length > 0 ? Math.min(1, nice1.score / nice.length) : 0,
      detail: [...nice1.direct, ...nice1.adjacent.map((a) => a.skillId)],
    },
    {
      dimension: 'stage',
      applicable: stage != null && Number.isFinite(stage),
      ratio: stage != null && Number.isFinite(stage) ? Math.min(1, Math.max(0, stage)) : 0,
      detail: [],
    },
    {
      dimension: 'title',
      applicable: !!title && !!target,
      ratio: !!title && !!target && (target.includes(title) || title.includes(target)) ? 1 : 0,
      detail: [],
    },
    {
      dimension: 'location',
      applicable: remote || !!roleCity,
      ratio: remote ? 1 : roleCity && norm(cand.city) === roleCity ? 1 : 0,
      detail: [],
    },
  ];
}

export function scoreFit(req: FitRequisition, cand: FitCandidate, edges: readonly SkillEdgeRow[] = []): FitScore {
  const evaluated = evaluate(req, cand, edges);
  const totalWeight = evaluated.reduce((sum, e) => sum + (e.applicable ? REQUISITION_FIT_WEIGHTS[e.dimension] : 0), 0);
  const breakdown: MatchBreakdownEntry[] = evaluated.map((e) => {
    const weight = REQUISITION_FIT_WEIGHTS[e.dimension];
    const contribution = e.applicable && totalWeight > 0 ? (100 * weight * e.ratio) / totalWeight : 0;
    return {
      dimension: e.dimension,
      kind: 'WEIGHTED',
      weight: e.applicable ? weight : 0,
      ratio: Math.round(e.ratio * 100) / 100,
      contribution: Math.round(contribution * 10) / 10,
      passed: e.applicable && e.ratio > 0,
      detail: e.detail,
    };
  });
  const raw = evaluated.reduce(
    (sum, e) => sum + (e.applicable && totalWeight > 0 ? (100 * REQUISITION_FIT_WEIGHTS[e.dimension] * e.ratio) / totalWeight : 0),
    0
  );
  return { score: Math.round(raw), breakdown, ruleSetVersion: REQUISITION_FIT_RULESET_VERSION };
}

/**
 * How far along the on-path stages `stageKey` is, 0…1, or null when it is not
 * on the path (off-path, unknown, or there is nothing to compare). The caller
 * passes the org's resolved stages in order.
 */
export function stageProgressOf(
  stageKey: string | null | undefined,
  stages: ReadonlyArray<{ key: string; isOffPath?: boolean }>
): number | null {
  if (!stageKey) return null;
  const onPath = stages.filter((s) => !s.isOffPath);
  const i = onPath.findIndex((s) => s.key === stageKey);
  if (i < 0 || onPath.length < 2) return null;
  return i / (onPath.length - 1);
}
