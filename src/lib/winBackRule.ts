// Winning a lost customer back (#2842) — the rule,
// dependency-free and unit-tested (scripts/test/win-back.test.mjs).
//
// A customer whose journey ended in DEAL_LOST and who returns starts a NEW
// journey: the lost one closes (COMPLETED + ENDED_CHURNED), the new one opens
// at the stage it really enters and points back with `previousRelationId`.
// Not an in-place DEAL_LOST → DEAL_WON move: the funnel triangle counts a
// journey's first win and first loss, so an in-place return would keep the
// churn but never show the win-back as a win, and could never open a second
// trial window (`trialEndsAt` is never overwritten).

export const LOST_STAGE_KEY = 'DEAL_LOST';

/** Where a returning customer may start: a fresh trial, or signed straight away. */
export const WIN_BACK_STAGES = ['TRIAL_ACTIVE', 'DEAL_WON'] as const;
export type WinBackStage = (typeof WIN_BACK_STAGES)[number];

export type WinBackPlan =
  | { ok: true; toStage: WinBackStage }
  | { ok: false; error: 'not_lost' | 'closed' | 'bad_stage' | 'stage_missing' };

export function planWinBack(input: {
  relation: { status: string; pipelineStatus: string | null };
  toStage: string;
  /** The org's own stage keys: a stage the tenant deleted is not offered. */
  stageKeys: readonly string[];
}): WinBackPlan {
  if (input.relation.status !== 'ACTIVE') return { ok: false, error: 'closed' };
  if (input.relation.pipelineStatus !== LOST_STAGE_KEY) return { ok: false, error: 'not_lost' };
  if (!(WIN_BACK_STAGES as readonly string[]).includes(input.toStage)) return { ok: false, error: 'bad_stage' };
  if (!input.stageKeys.includes(input.toStage)) return { ok: false, error: 'stage_missing' };
  return { ok: true, toStage: input.toStage as WinBackStage };
}
