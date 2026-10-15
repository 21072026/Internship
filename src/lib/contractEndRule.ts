// A won customer's notice period (#2841) — the rule,
// dependency-free and unit-tested (scripts/test/contract-end.test.mjs).
//
// The funnel ends at DEAL_WON. What happens to a customer after that is not a
// stage but a date: a customer who gives notice keeps paying until the
// contract ends, so the record STAYS in DEAL_WON with `contractEndsAt` set,
// shows `cancellation_pending` in its owner's attention queue, and gets one
// bell on the end day. Nothing moves it to DEAL_LOST by itself — a lost
// customer is too expensive an event for an unattended write to record
// wrongly. Clearing the date is the customer withdrawing notice:
// no stage move, no churn.

import { daysUntilUtcDay, parseTrialEndDate } from './trialReminderRule';

/** The won stage of the MARKETING funnel — where a customer lives. */
export const CONTRACT_STAGE_KEY = 'DEAL_WON';

/** The same `YYYY-MM-DD` → UTC midnight rule as the trial end. */
export const parseContractEndDate = parseTrialEndDate;

export type ContractEndPlan =
  | { ok: true; changed: boolean; contractEndsAt: Date | null }
  | { ok: false; error: 'not_won' | 'invalid_date' | 'in_the_past' };

/**
 * May this record's contract end be set to `next` (a day, or null to clear)?
 * Only a won record carries one; a new date must be today or later — a notice
 * is about the future, and a past date would ring the end-day bell at once.
 * Clearing is always allowed on a won record.
 */
export function planContractEndChange(input: {
  pipelineStatus: string | null | undefined;
  current: Date | null;
  next: Date | null | undefined;
  /** True when the caller sent a value that did not parse. */
  invalid?: boolean;
  now: Date;
}): ContractEndPlan {
  if (input.pipelineStatus !== CONTRACT_STAGE_KEY) return { ok: false, error: 'not_won' };
  if (input.invalid) return { ok: false, error: 'invalid_date' };
  const next = input.next ?? null;
  if (next && daysUntilUtcDay(next, input.now) < 0) return { ok: false, error: 'in_the_past' };
  const same = (input.current?.getTime() ?? null) === (next?.getTime() ?? null);
  return { ok: true, changed: !same, contractEndsAt: next };
}

/** Has this customer given notice? Shown as `cancellation_pending`. */
export function isCancellationPending(r: { pipelineStatus: string | null | undefined; contractEndsAt: Date | string | null | undefined }): boolean {
  return r.pipelineStatus === CONTRACT_STAGE_KEY && !!r.contractEndsAt;
}

/** Is the end-day bell due for this record now (the day has come, not yet rung)? */
export function contractEndReminderDue(r: {
  pipelineStatus: string | null | undefined;
  contractEndsAt: Date | null;
  contractEndRemindedAt: Date | null;
  now: Date;
}): boolean {
  if (!isCancellationPending(r) || r.contractEndRemindedAt) return false;
  return daysUntilUtcDay(r.contractEndsAt!, r.now) <= 0;
}
