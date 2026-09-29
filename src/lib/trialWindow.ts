// The Prisma-aware half of trial-window stamping (#2551).
//
// The rule — which dates a stage write adds, and that it never overwrites one
// already there — is `trialWindowFor()` in lib/trialReminderRule.ts, pure and
// unit-tested. What a route cannot do from the pure function alone is resolve
// the tenant's `trialLengthDays` setting, so this wrapper does exactly that and
// nothing else: it writes nothing, and for every stage other than TRIAL_ACTIVE
// it answers `{}` without touching the database, so spreading it into a write
// that has nothing to do with trials costs nothing.
//
// Callers spread the result into the SAME `data` block that moves
// `pipelineStatus`, so the stage and its window commit together:
//
//   data: { pipelineStatus: to, ...(await stageTrialWindow({ orgId, toStage: to, enteredAt: now, existing: relation })) }

import { getSetting } from './settings';
import {
  TRIAL_ACTIVE_STAGE_KEY,
  parseTrialLengthDays,
  trialWindowFor,
  type ExistingTrialWindow,
  type TrialWindowData,
} from './trialReminderRule';

/** The tenant's trial length in days: org row → global row → 30. */
export async function trialLengthDaysFor(orgId: string | null | undefined): Promise<number> {
  return parseTrialLengthDays(await getSetting('trialLengthDays', orgId ?? null));
}

export interface StageTrialWindowInput {
  /** The record's org — the setting is resolved for it, never from request input. */
  orgId: string | null | undefined;
  toStage: string | null | undefined;
  enteredAt: Date;
  existing?: ExistingTrialWindow | null;
}

/**
 * `trialWindowFor()` with the tenant's own trial length filled in. Returns `{}`
 * (and reads nothing) unless the write moves the record into TRIAL_ACTIVE and
 * the record has no trial end yet.
 */
export async function stageTrialWindow({
  orgId,
  toStage,
  enteredAt,
  existing,
}: StageTrialWindowInput): Promise<TrialWindowData> {
  if (toStage !== TRIAL_ACTIVE_STAGE_KEY || existing?.trialEndsAt) return {};
  const lengthDays = await trialLengthDaysFor(orgId);
  return trialWindowFor({ toStage, enteredAt, existing, lengthDays });
}
