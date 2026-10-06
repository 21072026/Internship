// The admin health monitor's "one thing to do about it" (#1902) — pure and
// client-safe, unit-tested in scripts/test/admin-health.test.mjs.
//
// EXACTLY ONE action per row, and it is a destination, not advice: every kind
// maps to a screen where the fix is one more click. The order below is the
// order of what unblocks the pair soonest:
//
//   1. reassign        — the mentor's account is deactivated: nobody is on the
//                        other end, so nothing else on this list can work.
//   2. record_dropoff  — nobody has been in touch for DROPOFF_SILENCE_DAYS
//                        (or ever, on a pair that old): either it is revived
//                        or the programme records why it ended, so the
//                        drop-off breakdown stays honest.
//   3. message_mentor  — the mentee is waiting on the mentor (a question, a
//                        meeting request).
//   4. set_deadline    — the stage deadline has passed.
//   5. message_mentor  — the pair is drifting (no contact, no reports, nothing
//                        open): a nudge to the mentor.
//   6. set_deadline    — the stage has not moved in two months: a deadline is
//                        what puts a stalled stage back on a clock.

import type { HealthReason } from './relationHealth';

export type NextActionKind = 'reassign' | 'record_dropoff' | 'message_mentor' | 'set_deadline';

export interface NextAction {
  kind: NextActionKind;
  /** Where the action is done. `message_mentor` opens a DM; see HealthNextAction. */
  href: string;
}

/** Silence long enough that "revive or record why it ended" is the question. */
export const DROPOFF_SILENCE_DAYS = 60;

export interface NextActionInput {
  relationId: string;
  menteeId: string;
  mentorId: string;
  mentorActive: boolean;
  reasons: readonly HealthReason[];
  /** Days since the last contact, or null when there has never been one. */
  daysSinceContact: number | null;
  /** Age of the relation in days. */
  ageDays: number;
}

export function nextActionFor(input: NextActionInput): NextAction | null {
  const has = (r: HealthReason) => input.reasons.includes(r);
  const pair = `/admin/candidates/${input.menteeId}#relation-stage`;
  const message = { kind: 'message_mentor' as const, href: `/admin/mentors/${input.mentorId}` };

  if (!input.mentorActive) return { kind: 'reassign', href: `/admin/mentorship?transfer=${input.relationId}` };
  const silentFor = input.daysSinceContact ?? input.ageDays;
  if (has('inactive') && silentFor >= DROPOFF_SILENCE_DAYS) return { kind: 'record_dropoff', href: pair };
  if (has('unanswered_question') || has('pending_meeting')) return message;
  if (has('overdue')) return { kind: 'set_deadline', href: pair };
  if (has('inactive') || has('missing_weekly_reports') || has('no_open_goal')) return message;
  if (has('stage_stalled')) return { kind: 'set_deadline', href: pair };
  return null;
}

const BAND_ORDER = { AT_RISK: 0, WATCH: 1, HEALTHY: 2 } as const;

/**
 * Worst first: band, then score (a pair too new to score sorts after every
 * scored pair of its band), then the number of reasons, then the longest
 * silence. Deterministic — ties end on the relation id.
 */
export function compareHealthRows(
  a: { band: keyof typeof BAND_ORDER; score: number | null; reasons: readonly string[]; daysSinceContact: number | null; relationId: string },
  b: { band: keyof typeof BAND_ORDER; score: number | null; reasons: readonly string[]; daysSinceContact: number | null; relationId: string },
): number {
  return (
    BAND_ORDER[a.band] - BAND_ORDER[b.band] ||
    (a.score ?? 101) - (b.score ?? 101) ||
    b.reasons.length - a.reasons.length ||
    (b.daysSinceContact ?? Infinity) - (a.daysSinceContact ?? Infinity) ||
    (a.relationId < b.relationId ? -1 : a.relationId > b.relationId ? 1 : 0)
  );
}
