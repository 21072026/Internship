// Who fits a requisition? (#1401) — the pure half, shared by the admin
// "matching candidates" list and the premium match-alert cron
// (checkRequisitionMatches in src/services/emailService.ts), so the screen and
// the e-mail can never disagree about who matches.
//
// The rule, in one place:
//   - a requisition WITH canonical required skills (`RequisitionSkill`) matches
//     a candidate through requisitionSkillMatch() — canonical ids, one-hop
//     adjacency, the coverage minimum of skillTaxonomyRule.ts;
//   - a requisition WITHOUT skills falls back to its title, compared with the
//     candidate's target position only (titleMatchesTarget) — never with skill
//     strings, which is what let "Go" match every "...go..." title;
//   - only the CONSENTING talent pool is ever matched (CONSENTING_POOL_WHERE):
//     publicProfile opt-in AND an active TALENT_POOL_VISIBILITY consent, the
//     same visibility rule as talent-pool search. A candidate without consent
//     is never offered for a shortlist the company will read.
//
// No Prisma import (the where-object is a plain literal), so the unit spec
// e2e/requisition-matches.unit.spec.ts reads the same rule the routes apply.
//
// The ORDER is the fit score (#2042, src/lib/matching/requisitionFit.ts): this
// rule decides who matches, scoreFit() ranks them and explains it. It never
// removes anybody — a low score only orders the list.
import { requisitionSkillMatch, type SkillEdgeRow } from '@/lib/skillTaxonomyRule';
import { scoreFit, type FitScore } from '@/lib/matching/requisitionFit';

/** The consenting talent pool, as a `User` where — role, active, opt-in, live consent. */
export const CONSENTING_POOL_WHERE = {
  role: 'MENTEE',
  isActive: true,
  publicProfile: true,
  consents: { some: { type: 'TALENT_POOL_VISIBILITY', grantedAt: { not: null }, revokedAt: null } },
} as const;

/** How many matches the admin list returns at most — the best ones, by score. */
export const MATCH_LIST_MAX = 50;

/**
 * A requisition that lists no required skills falls back to its title, but only
 * against the candidate's target position, in both directions.
 */
export function titleMatchesTarget(title: string, targetPosition: string | null | undefined): boolean {
  const pos = title.toLowerCase().trim();
  const target = (targetPosition || '').toLowerCase().trim();
  return !!pos && !!target && (target.includes(pos) || pos.includes(target));
}

export interface MatchCandidate {
  id: string;
  targetPosition: string | null;
  skillIds: readonly string[];
  /** Fit inputs (#2042); absent = that dimension is not applicable. */
  city?: string | null;
  stageProgress?: number | null;
}

/** A requisition as the rule reads it. `requiredSkillIds` is every canonical skill (matching, as before #2042). */
export interface MatchRequisition {
  title: string;
  requiredSkillIds: readonly string[];
  /** The subset that is only nice to have (`RequisitionSkill.required = false`) — weighted lower by the fit score. */
  niceSkillIds?: readonly string[];
  city?: string | null;
  workMode?: string | null;
}

export type RequisitionMatch = {
  candidateId: string;
  /** 'skills' when matched on canonical skills, 'title' on the title fallback. */
  via: 'skills' | 'title';
  score: number;
  /** Required skill ids the candidate holds. */
  direct: string[];
  /** A candidate skill standing in for a required one (`via` is the required id). */
  adjacent: { skillId: string; via: string; weight: number }[];
  /** The fit score and its breakdown (#2042) — the list's order. */
  fit: FitScore;
};

function fitOf(requisition: MatchRequisition, candidate: MatchCandidate, edges: readonly SkillEdgeRow[]): FitScore {
  const nice = requisition.niceSkillIds ?? [];
  return scoreFit(
    {
      title: requisition.title,
      requiredSkillIds: requisition.requiredSkillIds.filter((id) => !nice.includes(id)),
      niceSkillIds: nice,
      city: requisition.city,
      workMode: requisition.workMode,
    },
    candidate,
    edges
  );
}

/** One candidate against one requisition; null when they do not match. */
export function matchCandidate(
  requisition: MatchRequisition,
  candidate: MatchCandidate,
  edges: readonly SkillEdgeRow[],
): RequisitionMatch | null {
  if (requisition.requiredSkillIds.length > 0) {
    const m = requisitionSkillMatch(requisition.requiredSkillIds, candidate.skillIds, edges);
    if (!m.isMatch) return null;
    return { candidateId: candidate.id, via: 'skills', score: m.score, direct: m.direct, adjacent: m.adjacent, fit: fitOf(requisition, candidate, edges) };
  }
  if (!titleMatchesTarget(requisition.title, candidate.targetPosition)) return null;
  return { candidateId: candidate.id, via: 'title', score: 0, direct: [], adjacent: [], fit: fitOf(requisition, candidate, edges) };
}

/**
 * Every matching candidate, best first: fit score descending (#2042), then the
 * skill-overlap score, then more direct hits, then the id — a stable order, so
 * a reload shows the same list.
 */
export function rankRequisitionMatches(
  requisition: MatchRequisition,
  candidates: readonly MatchCandidate[],
  edges: readonly SkillEdgeRow[],
  limit = MATCH_LIST_MAX,
): RequisitionMatch[] {
  const out: RequisitionMatch[] = [];
  for (const c of candidates) {
    const m = matchCandidate(requisition, c, edges);
    if (m) out.push(m);
  }
  out.sort((a, b) => b.fit.score - a.fit.score || b.score - a.score || b.direct.length - a.direct.length || (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0));
  return out.slice(0, Math.max(0, limit));
}
