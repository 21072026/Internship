// The stage-SLA escalation ladder (#1722) — the rule, with no dependencies so
// a unit test can pin it (e2e/sla-ladder.unit.spec.ts).
//
// THE LADDER IS SHORT AND FIXED, ON PURPOSE. Two levels:
//
//   1 · the deadline passed       → the relation's mentor is told (the reminder
//                                   this product always sent, once per deadline)
//   2 · `escalateAfterDays` more  → the org's administrators are told
//
// and never a level twice for the same breach. It is not a rule engine: the
// general "when X, nudge Y" builder is #1684/#1686, and a second one here is
// the duplication epic #1705 exists to prevent. A programme-scoped manager
// would be a third rung; there is no such role in the data today (a Cohort has
// no owner), so the administrators of the relation's organisation ARE the
// programme admin until programmes get one (#1624).
//
// WHO NEVER ESCALATES. Whatever `isStageOverdue()` (src/lib/stageClock.ts)
// says is not overdue never opens a breach, and an open one is closed:
//   · terminal and off-path stages of the tenant's own pipeline — that
//     includes INTERNSHIP_DROPPED_460, which is off-path in the default
//     pipeline. Deliberately: a dropped internship is an ending, and the
//     stage it is waiting on is the next conversation, not this deadline.
//     The old sweep's hard-coded list did not name it (#1884 replaced that
//     list with the stage clock); the decision is now the clock's, written
//     down here;
//   · mentees in the re-engagement pool (`User.reEngageAt`), for the reason
//     the aging report gives: somebody agreed to write to them later, they are
//     not stuck, and a breach list full of them is a list nobody reads.
//
// ACKNOWLEDGE AND SNOOZE stop the climb, never the breach: an acknowledged
// breach stays open (and counts against the compliance rate) until the stage
// moves; it simply does not reach the next rung. A snooze holds it until
// `snoozedUntil`, then the ladder resumes from where it stood.

export const SLA_LEVEL_MENTOR = 1;
export const SLA_LEVEL_ADMIN = 2;
export const SLA_TOP_LEVEL = SLA_LEVEL_ADMIN;

const DAY = 24 * 60 * 60 * 1000;

export interface BreachState {
  level: number;
  dueAt: Date;
  acknowledgedAt: Date | null;
  snoozedUntil: Date | null;
}

/** The instant the next rung is due, or null when there is no next rung. */
export function nextEscalationAt(breach: BreachState, escalateAfterDays: number | null | undefined): Date | null {
  if (breach.level >= SLA_TOP_LEVEL) return null;
  if (escalateAfterDays == null || escalateAfterDays <= 0) return null;
  return new Date(breach.dueAt.getTime() + escalateAfterDays * DAY);
}

/** Should this sweep climb the breach one rung? */
export function escalationDue(
  breach: BreachState,
  escalateAfterDays: number | null | undefined,
  now: Date
): boolean {
  if (breach.acknowledgedAt) return false;
  if (breach.snoozedUntil && breach.snoozedUntil.getTime() > now.getTime()) return false;
  const at = nextEscalationAt(breach, escalateAfterDays);
  return at != null && at.getTime() <= now.getTime();
}

/**
 * Opening a breach: does the mentor still need to be told?
 *
 * `deadlineReminderSentAt` is the one-shot stamp the reminder wrote before the
 * ladder existed. Every write of a NEW deadline clears it (stageSla.ts, the
 * candidate PUT, the account-event feed), so a stamp that is set when the
 * breach opens means this very deadline was already reminded about — the
 * first sweep after the deploy adopts it at level 1 instead of re-sending.
 */
export function mentorAlreadyTold(deadlineReminderSentAt: Date | null | undefined): boolean {
  return deadlineReminderSentAt != null;
}

/** Whole days a breach has stood, for the escalation text. Never below 1. */
export function daysOverdue(dueAt: Date, now: Date): number {
  return Math.max(1, Math.floor((now.getTime() - dueAt.getTime()) / DAY));
}

/** The longest snooze an admin may set — beyond that, acknowledge it instead. */
export const MAX_SNOOZE_DAYS = 90;

/** Is `until` an acceptable snooze end? In the future and at most MAX_SNOOZE_DAYS away. */
export function validSnooze(until: Date, now: Date): boolean {
  const t = until.getTime();
  return Number.isFinite(t) && t > now.getTime() && t <= now.getTime() + MAX_SNOOZE_DAYS * DAY;
}
