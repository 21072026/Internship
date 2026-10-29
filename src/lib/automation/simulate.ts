// The dry run of a stage automation rule (#1704) — pure, client-safe.
//
// Replays a rule against REAL past stage moves (`StatusChange` rows the route
// reads) and answers, per move, "would this rule have fired, and what would it
// have done". It is structurally incapable of executing an action: this module
// imports ./rule.ts (the vocabulary and the ONE condition evaluator the live
// engine also calls) and nothing else — not ./engine.ts, not ./actions.ts, not
// a mailer. `e2e/automation-builder.unit.spec.ts` pins that import list.
//
// The verdicts are the live engine's verdicts on the same inputs: the trigger
// match (`ruleMatchesMove`), the conditions (`evaluateConditions`), and the
// outcome-stage rule (a mentee-facing action on a relation that landed on an
// ending stage would be skipped).

import {
  addressesMentee,
  evaluateConditions,
  ruleMatchesMove,
  wholeDaysBetween,
  type AutomationAction,
  type AutomationCondition,
  type ConditionField,
} from './rule';

export const SIMULATE_DEFAULT_LIMIT = 200;
export const SIMULATE_MAX_LIMIT = 500;

/** One past move, as the route reads it. */
export interface HistoryMove {
  id: string;
  relationId: string;
  from: string;
  to: string;
  at: Date;
  kind: string;
  hasCompany: boolean;
  relationStart: Date;
  /** Shown in the result so an admin recognises the case. Never stored. */
  menteeName: string;
}

/** Every recorded entry into a stage, per relation — what `daysInFromStage` is computed from. */
export type StageEntries = ReadonlyMap<string, readonly { stage: string; at: Date }[]>;

export interface SimulatedMove {
  moveId: string;
  relationId: string;
  menteeName: string;
  from: string;
  to: string;
  at: string;
  verdict: 'fire' | 'skip';
  /** The condition fields that did not hold (skip). */
  failed: ConditionField[];
  /** The actions that would have run, in order, with the ones an outcome stage would skip. */
  actions: { index: number; type: string; outcome: 'would_run' | 'skipped_outcome_stage' }[];
}

export interface SimulationResult {
  considered: number;
  matched: number;
  wouldFire: number;
  moves: SimulatedMove[];
}

function enteredBefore(entries: StageEntries, relationId: string, stage: string, at: Date): Date | null {
  let best: Date | null = null;
  for (const e of entries.get(relationId) ?? []) {
    if (e.stage === stage && e.at.getTime() < at.getTime() && (!best || e.at > best)) best = e.at;
  }
  return best;
}

/**
 * Judge `rule` against `history` (newest first). Only the moves the trigger
 * matches are returned; `considered` is how many moves were looked at.
 */
export function simulateRule(
  rule: { trigger: string; stageKey: string; conditions: readonly AutomationCondition[]; actions: readonly AutomationAction[] },
  history: readonly HistoryMove[],
  entries: StageEntries,
  isOutcomeStage: (key: string) => boolean,
): SimulationResult {
  const moves: SimulatedMove[] = [];
  for (const move of history) {
    if (!ruleMatchesMove(rule, move)) continue;
    const verdict = evaluateConditions(rule.conditions, {
      kind: move.kind,
      hasCompany: move.hasCompany,
      fromStage: move.from,
      toStage: move.to,
      daysInFromStage: wholeDaysBetween(enteredBefore(entries, move.relationId, move.from, move.at) ?? move.relationStart, move.at),
    });
    const outcome = isOutcomeStage(move.to);
    moves.push({
      moveId: move.id,
      relationId: move.relationId,
      menteeName: move.menteeName,
      from: move.from,
      to: move.to,
      at: move.at.toISOString(),
      verdict: verdict.pass ? 'fire' : 'skip',
      failed: verdict.failed,
      actions: verdict.pass
        ? rule.actions.map((a, index) => ({ index, type: a.type, outcome: outcome && addressesMentee(a) ? 'skipped_outcome_stage' : 'would_run' }))
        : [],
    });
  }
  return { considered: history.length, matched: moves.length, wouldFire: moves.filter((m) => m.verdict === 'fire').length, moves };
}
