// The closure report (#1795) — pure, client-safe and unit-tested
// (scripts/test/closure-report.test.mjs). The loader is src/lib/closureReportData.ts.
//
// "Of the pairings that ended this term, how did they end, and how did the
// people in them rate them?" — grouped by HOW the pairing ended (its lifecycle
// state) and the end reason within it, next to the close-loop survey's
// answers (the `relation_close` template, src/lib/surveyTemplates.ts).
//
// TWO RULES THIS FILE EXISTS FOR:
//   · Only the COMPLETED state is a success. A pairing that ended early (no
//     fit, mentor unavailable, …), was re-matched, reassigned or churned is
//     listed under its own outcome and is never counted as a completion —
//     the correction epic #1766 is about.
//   · The answers are CONFIDENTIAL survey answers: a group's scores are shown
//     only above the response floor (applyResponseFloor, residual included),
//     so no group of three people can be read back. Counts of PAIRINGS are
//     not answers and are always shown.

import { applyResponseFloor, effectiveMinResponses } from '@/lib/surveyPrivacy';
import { npsFromScores, type Nps } from '@/lib/nps';

export const CLOSURE_TEMPLATE_KEY = 'relation_close';
/** The closure plan's length cap (MentorshipRelation.closurePlan). */
export const CLOSURE_PLAN_MAX = 2000;

export type ClosureOutcome = 'completed' | 'ended_early' | 'rematched' | 'reassigned' | 'churned';

const OUTCOME_ORDER: ClosureOutcome[] = ['completed', 'ended_early', 'rematched', 'reassigned', 'churned'];

/** How a pairing ended. A live or unknown state is not an ending: null. */
export function closureOutcome(lifecycleState: string | null | undefined): ClosureOutcome | null {
  switch (lifecycleState) {
    case 'COMPLETED':
      return 'completed';
    case 'ENDED_EARLY':
      return 'ended_early';
    case 'ENDED_REMATCHED':
      return 'rematched';
    case 'ENDED_REASSIGNED':
      return 'reassigned';
    case 'ENDED_CHURNED':
      return 'churned';
    default:
      return null;
  }
}

export const isSuccessfulOutcome = (o: ClosureOutcome) => o === 'completed';

/** One answered close-loop survey: the three scored answers, as stored. */
export interface ClosureAnswer {
  overall: unknown;
  goalsMet: unknown;
  nps: unknown;
}

export interface ClosureReportRelation {
  lifecycleState: string | null;
  endReasonCode: string | null;
  startDate: Date;
  completedAt: Date | null;
  /** Invitations sent for this pairing (one per participant reached). */
  invited: number;
  /** The answers received. */
  answers: ClosureAnswer[];
}

export interface ClosureScores {
  avgOverall: number | null;
  avgGoalsMet: number | null;
  nps: Nps;
}

export interface ClosureReportGroup {
  outcome: ClosureOutcome;
  /** The end reason within the outcome (`null` = none recorded). */
  reasonCode: string | null;
  success: boolean;
  relations: number;
  invited: number;
  /** null when the group's answers are under the floor (or hidden with it). */
  responses: number | null;
  scores: ClosureScores | null;
}

export interface ClosureReport {
  relations: number;
  successes: number;
  invited: number;
  responses: number;
  /** 0..100 responses / invitations; null without an invitation. */
  responseRatePct: number | null;
  /** Median length of the ended pairings in whole days; null when none. */
  medianLengthDays: number | null;
  /** All answers together; null under the floor. */
  scores: ClosureScores | null;
  groups: ClosureReportGroup[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const scaleValue = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);

function average(values: unknown[]): number | null {
  const xs = values.map(scaleValue).filter((v): v is number => v !== null);
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
}

function scoresOf(answers: ClosureAnswer[], minResponses?: number | null): ClosureScores {
  return {
    avgOverall: average(answers.map((a) => a.overall)),
    avgGoalsMet: average(answers.map((a) => a.goalsMet)),
    // The floor is applied by the caller; here every answer counts.
    nps: npsFromScores(answers.map((a) => a.nps), Math.min(1, effectiveMinResponses(minResponses))),
  };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function buildClosureReport(rows: ClosureReportRelation[], minResponses?: number | null): ClosureReport {
  const floor = effectiveMinResponses(minResponses);
  const groups = new Map<string, { outcome: ClosureOutcome; reasonCode: string | null; relations: number; invited: number; answers: ClosureAnswer[] }>();
  const lengths: number[] = [];
  const all: ClosureAnswer[] = [];
  let relations = 0;
  let successes = 0;
  let invited = 0;
  for (const r of rows) {
    const outcome = closureOutcome(r.lifecycleState);
    if (!outcome) continue;
    relations += 1;
    if (isSuccessfulOutcome(outcome)) successes += 1;
    if (r.completedAt) lengths.push(Math.max(0, Math.round((r.completedAt.getTime() - r.startDate.getTime()) / DAY_MS)));
    const key = `${outcome}|${r.endReasonCode ?? ''}`;
    const g = groups.get(key) ?? { outcome, reasonCode: r.endReasonCode, relations: 0, invited: 0, answers: [] };
    g.relations += 1;
    g.invited += r.invited;
    g.answers.push(...r.answers);
    groups.set(key, g);
    invited += r.invited;
    all.push(...r.answers);
  }

  const floored = new Map(
    applyResponseFloor([...groups.entries()].map(([key, g]) => ({ key, n: g.answers.length })), floor).map((b) => [b.key, b]),
  );
  const out: ClosureReportGroup[] = [...groups.entries()]
    .map(([key, g]) => {
      const shown = floored.get(key);
      const visible = !!shown && !shown.suppressed;
      return {
        outcome: g.outcome,
        reasonCode: g.reasonCode,
        success: isSuccessfulOutcome(g.outcome),
        relations: g.relations,
        invited: g.invited,
        responses: visible ? g.answers.length : null,
        scores: visible ? scoresOf(g.answers, floor) : null,
      };
    })
    .sort((a, b) => OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome) || b.relations - a.relations);

  return {
    relations,
    successes,
    invited,
    responses: all.length,
    responseRatePct: invited > 0 ? Math.round((all.length / invited) * 100) : null,
    medianLengthDays: median(lengths),
    scores: all.length >= floor ? scoresOf(all, floor) : null,
    groups: out,
  };
}
