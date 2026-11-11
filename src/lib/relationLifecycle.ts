// How a mentorship RELATION ended, when "COMPLETED" is not the honest answer
// (#1801). Client-safe — no Prisma import — so the API routes, the admin queue
// and the portal form all read the exact same lists.
//
// `MentorshipRelation.status` keeps its old job ("is this pairing live"), so
// every existing ACTIVE/COMPLETED check is untouched. `lifecycleState` is the
// second, nullable column that says *why* a closed pairing closed. Without it
// the only way out of a bad match was an admin marking it COMPLETED, which
// records a success that never happened — the exact corruption this workflow
// exists to remove.
//
// Validated the same way as the drop-off reasons next door
// (src/lib/dropoffReasons.ts): z.string() + a whitelist, never z.enum, so a new
// key never needs a schema change (CLAUDE.md).

import { BILLABLE_RELATION_STATES, isBillableRelationState } from './meteringRules';

//
// THE STATE MACHINE (#1768). The column now carries every state a pairing can be
// in, not only how it ended:
//
//   ACTIVE ⇄ PAUSED            live; PAUSED is an operational hold (parental
//                              leave, exam season) — never a feature gate
//   ACTIVE | PAUSED → terminal COMPLETED, or one of the ENDED_* states below
//   terminal → ACTIVE          only as an explicit admin reopen
//
// `status` (ACTIVE | COMPLETED) is kept, untouched as an enum, and is now the
// DERIVED liveness flag: statusForLifecycle() is the one place that derivation
// is written down, and nothing that moves a relation between states may set
// `status` any other way. Every existing `status: 'ACTIVE'` reader keeps
// working because a paused pair is still `status = ACTIVE`.
//
// The column is a free String (with a DB default of 'ACTIVE'), not an enum, for
// the same reason `pipelineStatus` is one (#747): an ENUM→VARCHAR change is a
// migration we cannot review under `db push`, and a new state should never need
// a schema change. Don't "tidy" it into an enum.
//
// It is still NULLABLE on purpose — expand → backfill → contract (#2298): rows
// written before #1768 carry NULL until prisma/backfill-relation-lifecycle.mjs
// fills them on deploy, and a required column would have been refused by
// `db push` on a populated table. effectiveLifecycleState() reads NULL the way
// the backfill would fill it, so no reader depends on the backfill having run.

/** The live states: the pairing is open (`status = ACTIVE`). */
export const LIVE_LIFECYCLE_STATES = ['ACTIVE', 'PAUSED'] as const;

/** Every state a relation can carry. */
export const RELATION_LIFECYCLE_STATES = [
  ...LIVE_LIFECYCLE_STATES,
  'COMPLETED',
  'ENDED_EARLY',
  'ENDED_REMATCHED',
  'ENDED_REASSIGNED',
  'ENDED_CHURNED',
] as const;

export type RelationLifecycleState = (typeof RELATION_LIFECYCLE_STATES)[number];
export type LiveLifecycleState = (typeof LIVE_LIFECYCLE_STATES)[number];

export const ACTIVE: RelationLifecycleState = 'ACTIVE';
/** On hold: still `status = ACTIVE`, but out of every nudge, queue and the meter. */
export const PAUSED: RelationLifecycleState = 'PAUSED';
/** The pairing ran its course — the only terminal state that reads as a success. */
export const COMPLETED: RelationLifecycleState = 'COMPLETED';
/**
 * The pairing stopped before it finished and nothing replaced it (#1770) — the
 * mentor left, the mentee became unavailable, it was not a fit. WHY is the
 * relation's `endReasonCode` (LIFECYCLE_END_REASON_CODES); the state only says
 * "ended, not completed", so no report or certificate reads it as a success.
 */
export const ENDED_EARLY: RelationLifecycleState = 'ENDED_EARLY';

export function isRelationLifecycleState(value: unknown): value is RelationLifecycleState {
  return typeof value === 'string' && (RELATION_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/** True for ACTIVE and PAUSED — the pairing is open. */
export function isLive(state: string | null | undefined): boolean {
  return !!state && (LIVE_LIFECYCLE_STATES as readonly string[]).includes(state);
}

/** True for COMPLETED and every ENDED_* state. */
export function isTerminal(state: string | null | undefined): boolean {
  return isRelationLifecycleState(state) && !isLive(state);
}

/**
 * THE derivation rule: ACTIVE and PAUSED are `status = ACTIVE`, everything else
 * is `status = COMPLETED`. The only place it is written down — a writer that
 * moves a relation between states sets `status: statusForLifecycle(to)`.
 */
export function statusForLifecycle(state: RelationLifecycleState): 'ACTIVE' | 'COMPLETED' {
  return isLive(state) ? 'ACTIVE' : 'COMPLETED';
}

/**
 * Which moves are legal. ACTIVE ⇄ PAUSED; either live state may end in any
 * terminal state; a terminal state only goes back to ACTIVE (an explicit admin
 * reopen — who may do it is the endpoint's rule, not this table's). A terminal
 * state never becomes another terminal state: how a pairing ended is history.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<RelationLifecycleState, readonly RelationLifecycleState[]>> = {
  ACTIVE: ['PAUSED', 'COMPLETED', 'ENDED_EARLY', 'ENDED_REMATCHED', 'ENDED_REASSIGNED', 'ENDED_CHURNED'],
  PAUSED: ['ACTIVE', 'COMPLETED', 'ENDED_EARLY', 'ENDED_REMATCHED', 'ENDED_REASSIGNED', 'ENDED_CHURNED'],
  COMPLETED: ['ACTIVE'],
  ENDED_EARLY: ['ACTIVE'],
  ENDED_REMATCHED: ['ACTIVE'],
  ENDED_REASSIGNED: ['ACTIVE'],
  ENDED_CHURNED: ['ACTIVE'],
};

export function canTransition(from: string | null | undefined, to: string): boolean {
  if (!isRelationLifecycleState(from) || !isRelationLifecycleState(to)) return false;
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * The state a stored row is in. `status` stays authoritative for liveness, so a
 * row that a not-yet-migrated writer flipped by `status` alone still reads
 * truthfully:
 *
 *   · status ACTIVE    → PAUSED when the column says so, otherwise ACTIVE
 *                        (a NULL or a stale terminal value cannot make an open
 *                        pairing read as closed)
 *   · status COMPLETED → the column's terminal state when it carries one,
 *                        otherwise COMPLETED (NULL, or a stale ACTIVE/PAUSED
 *                        from a writer that set only `status`)
 *
 * The same mapping prisma/backfill-relation-lifecycle.mjs writes, so a row
 * reads the same before and after the backfill.
 */
export function effectiveLifecycleState(relation: {
  status: string;
  lifecycleState?: string | null;
}): RelationLifecycleState {
  const stored = relation.lifecycleState;
  if (relation.status === 'ACTIVE') return stored === PAUSED ? PAUSED : ACTIVE;
  return isTerminal(stored) ? (stored as RelationLifecycleState) : COMPLETED;
}

/**
 * True when a pair in this state goes on the invoice. Delegates to the ONE
 * billing allowlist (BILLABLE_RELATION_STATES in src/lib/meteringRules.ts, #1750)
 * — exported here so lifecycle callers ask this module, never a second list.
 */
export function isBillable(state: string | null | undefined): boolean {
  return isBillableRelationState(state);
}

/** The mentee asked for a different mentor and an admin approved it. */
export const ENDED_REMATCHED: RelationLifecycleState = 'ENDED_REMATCHED';

/**
 * An admin moved the mentee to another mentor (#2289) — the mentor left, or the
 * pairing was a mis-assignment. The mirror image of ENDED_REMATCHED: same
 * outcome, the other side asked for it. Kept as its own state rather than
 * folded into it, because "who decided" is the whole difference between the two
 * and a report that cannot tell them apart cannot answer either question.
 */
export const ENDED_REASSIGNED: RelationLifecycleState = 'ENDED_REASSIGNED';

/**
 * A customer who was lost (DEAL_LOST) came back (#2842):
 * the lost journey closes with this state and a NEW journey starts, linked by
 * `previousRelationId`. Not COMPLETED-as-success, and not a mentor change —
 * the predecessor chain on the account page labels it as a win-back.
 */
export const ENDED_CHURNED: RelationLifecycleState = 'ENDED_CHURNED';

/** True when this relation was closed because the customer churned and came back. */
export function endedByChurn(relation: { lifecycleState?: string | null }): boolean {
  return relation.lifecycleState === ENDED_CHURNED;
}

/**
 * Why a pairing ended, as picked by the person ending it. ONE list, shared by
 * the re-match form and anything that ends a relation later — deliberately not
 * a second parallel vocabulary.
 */
export const END_REASON_CODES = [
  'mentor_unavailable',
  'no_fit',
  'changed_goals',
  'other',
] as const;

export type EndReasonCode = (typeof END_REASON_CODES)[number];

export function isEndReasonCode(value: string): value is EndReasonCode {
  return (END_REASON_CODES as readonly string[]).includes(value);
}

/**
 * The reasons an ADMIN can end a pairing with: the shared list above plus the
 * two only an admin ever has. A superset rather than a second vocabulary —
 * `wrong_assignment` ("I picked the wrong person in the assign dialog") and
 * `mentee_request` ("they asked me off-platform") are not things a mentee picks
 * in the re-match form, and putting them in END_REASON_CODES would offer them
 * there.
 */
export const ADMIN_END_REASON_CODES = [
  ...END_REASON_CODES,
  'wrong_assignment',
  'mentee_request',
] as const;

export type AdminEndReasonCode = (typeof ADMIN_END_REASON_CODES)[number];

export function isAdminEndReasonCode(value: string): value is AdminEndReasonCode {
  return (ADMIN_END_REASON_CODES as readonly string[]).includes(value);
}

/**
 * The one reason code that requires the free-text note — same rule the
 * drop-off reasons apply (src/lib/dropoffReasons.ts): "other" with nothing
 * written down is a reason nobody can read later.
 */
export const REASON_NOTE_REQUIRED_FOR = 'other';

/**
 * True when this relation was closed by a re-match. Callers use it to keep a
 * re-match out of completion/placement counts and out of certificate
 * eligibility: the pairing ended, the programme did not finish.
 */
export function isRematched(relation: { lifecycleState?: string | null }): boolean {
  return relation.lifecycleState === ENDED_REMATCHED;
}

/**
 * True when this relation was closed because the mentee moved to another mentor
 * — by their own request (`ENDED_REMATCHED`) or by an admin transfer
 * (`ENDED_REASSIGNED`). The distinction matters for reporting; for "did this
 * mentorship finish?" it does not, and every caller asking THAT question should
 * ask it here rather than listing the states itself.
 */
export function endedByMentorChange(relation: { lifecycleState?: string | null }): boolean {
  return relation.lifecycleState === ENDED_REMATCHED || relation.lifecycleState === ENDED_REASSIGNED;
}

/**
 * The billable-pair STATE filter, as a Prisma-ready `where` fragment — the SQL
 * twin of isBillable(effectiveLifecycleState(row)). `status: 'ACTIVE'` stays in
 * it because `status` is authoritative for liveness: a row a legacy writer
 * closed by `status` alone may still carry 'ACTIVE' in the column. Both the
 * invoice (activeMatchedPairs) and the plan gate's capacity count
 * (countActiveRelations) read it, so a paused pair is neither billed nor
 * counted against a plan cap. Plain object, no Prisma import — this module
 * stays client-safe.
 */
export function billableRelationWhere() {
  return {
    status: 'ACTIVE' as const,
    lifecycleState: { in: [...BILLABLE_RELATION_STATES] as string[] },
  };
}

/**
 * True when the pairing is over but did not COMPLETE — ended early, re-matched,
 * reassigned, churned. The question a certificate, a completion count or a
 * placement report asks; ask it here rather than listing the states.
 */
export function endedWithoutCompleting(relation: { lifecycleState?: string | null }): boolean {
  return isTerminal(relation.lifecycleState) && relation.lifecycleState !== COMPLETED;
}

// ── The lifecycle endpoint's rules (#1770) ──────────────────────────────────
// POST /api/mentorship/[id]/lifecycle is the one writer of the moves below; the
// rules live here, pure, so the route, the dialogs and the unit test agree.

/**
 * The states the lifecycle endpoint may move a relation INTO. The other three
 * ENDED_* states each belong to a flow that also creates the successor
 * relation (re-match, transfer, win-back) — ending a pairing as "re-matched"
 * without one would be the very lie those flows exist to stop.
 */
export const LIFECYCLE_ENDPOINT_TARGETS = ['ACTIVE', 'PAUSED', 'COMPLETED', 'ENDED_EARLY'] as const;
export type LifecycleEndpointTarget = (typeof LIFECYCLE_ENDPOINT_TARGETS)[number];

export function isLifecycleEndpointTarget(value: unknown): value is LifecycleEndpointTarget {
  return typeof value === 'string' && (LIFECYCLE_ENDPOINT_TARGETS as readonly string[]).includes(value);
}

/**
 * Why a pairing ended, for an end through the lifecycle endpoint. Builds on
 * END_REASON_CODES (the same lowercase vocabulary, not a parallel one) with the
 * reasons an end without a successor needs. `finished` and `programme_ended`
 * close as COMPLETED; every other code closes as ENDED_EARLY.
 */
export const LIFECYCLE_END_REASON_CODES = [
  'finished',
  'programme_ended',
  'mentor_unavailable',
  'mentee_unavailable',
  'no_fit',
  'schedule_conflict',
  'changed_goals',
  'other',
] as const;
export type LifecycleEndReasonCode = (typeof LIFECYCLE_END_REASON_CODES)[number];

/**
 * An extension of the agreed end date (#1786): recorded as a lifecycle event
 * whose `toState` equals its `fromState` — the pairing does not change state,
 * but the audit trail says when, by whom and (optionally) why it was extended.
 * Written only by src/lib/relationExtend.ts. Not an end reason.
 */
export const EXTENDED_REASON_CODE = 'extended';

/** The reasons that mean the pairing ran its course. */
export const COMPLETION_REASON_CODES: readonly LifecycleEndReasonCode[] = ['finished', 'programme_ended'];

export function isLifecycleEndReasonCode(value: unknown): value is LifecycleEndReasonCode {
  return typeof value === 'string' && (LIFECYCLE_END_REASON_CODES as readonly string[]).includes(value);
}

/**
 * The terminal state a reason closes a pairing in. One mapping, so the end
 * dialog asks for the reason alone and the server decides the state — nobody
 * can record "no fit" as a COMPLETED.
 */
export function endStateForReason(code: LifecycleEndReasonCode): 'COMPLETED' | 'ENDED_EARLY' {
  return COMPLETION_REASON_CODES.includes(code) ? 'COMPLETED' : 'ENDED_EARLY';
}

export type LifecycleRefusal =
  | { ok: false; status: 400; code: 'invalid_state' | 'reason_required' | 'invalid_reason' | 'note_required' | 'reason_mismatch' }
  | { ok: false; status: 403; code: 'forbidden' }
  | { ok: false; status: 409; code: 'illegal_transition'; from: RelationLifecycleState; to: string };

export type LifecycleCheck = { ok: true; from: RelationLifecycleState; to: LifecycleEndpointTarget } | LifecycleRefusal;

/**
 * Whether this actor may make this move, with this reason. ONE rule, read by
 * the endpoint before anything is written:
 *
 *   · ADMIN — any legal move, including the reopen (terminal → ACTIVE)
 *   · the relation's own MENTOR — pause, resume (PAUSED → ACTIVE) and end
 *     their own pairing; never a reopen (that is a fresh assignment, an admin
 *     decision under the one-active-mentor rule)
 *   · anyone else — refused. A mentee's way out is the re-match request
 *     (#1801), not this endpoint.
 *
 * An end needs a reason from LIFECYCLE_END_REASON_CODES whose end state
 * matches `to`; `other` needs a note.
 */
export function checkLifecycleMove(input: {
  role: string;
  isOwnMentor: boolean;
  relation: { status: string; lifecycleState?: string | null };
  to: unknown;
  reasonCode?: string | null;
  reasonNote?: string | null;
}): LifecycleCheck {
  const { role, isOwnMentor, to } = input;
  if (!isLifecycleEndpointTarget(to)) return { ok: false, status: 400, code: 'invalid_state' };
  const from = effectiveLifecycleState(input.relation);
  if (role !== 'ADMIN') {
    if (role !== 'MENTOR' || !isOwnMentor) return { ok: false, status: 403, code: 'forbidden' };
    if (to === ACTIVE && from !== PAUSED) return { ok: false, status: 403, code: 'forbidden' };
  }
  if (!canTransition(from, to)) return { ok: false, status: 409, code: 'illegal_transition', from, to };
  if (isTerminal(to)) {
    const code = input.reasonCode;
    if (!code) return { ok: false, status: 400, code: 'reason_required' };
    if (!isLifecycleEndReasonCode(code)) return { ok: false, status: 400, code: 'invalid_reason' };
    if (endStateForReason(code) !== to) return { ok: false, status: 400, code: 'reason_mismatch' };
    if (code === REASON_NOTE_REQUIRED_FOR && !input.reasonNote?.trim()) {
      return { ok: false, status: 400, code: 'note_required' };
    }
  }
  return { ok: true, from, to };
}

/** The notification a move sends to the pair (`notifications.events`). */
export function lifecycleNotificationType(from: RelationLifecycleState, to: LifecycleEndpointTarget): string {
  if (to === PAUSED) return 'relation.lifecycle_paused';
  if (to === ACTIVE) return from === PAUSED ? 'relation.lifecycle_resumed' : 'relation.lifecycle_reopened';
  return 'relation.lifecycle_ended';
}

// ── What a pause means for the sweeps (#1772) ───────────────────────────────

/**
 * "An active pair" for every nudge, queue and reminder: live AND not paused,
 * as a Prisma-ready `where` fragment. ONE definition — the interaction
 * reminder, the stage-deadline and next-action reminders, the weekly-report
 * chase, the dormant sweep and check-in, the missing-document chase and the
 * mentor attention queue all read it, so a paused pair leaves all of them at
 * once. Spread it into a `where` (`{ mentorId, ...activeRelationWhere() }`);
 * never hand-write `{ status: 'ACTIVE', lifecycleState: 'ACTIVE' }`.
 *
 * NOT a feature gate: messaging, meetings, goals, weekly reports, the portal
 * and the board keep reading `status: 'ACTIVE'`, which a paused pair still is.
 * Exact because prisma/backfill-relation-lifecycle.mjs leaves no live row with
 * a NULL or terminal lifecycleState.
 */
export function activeRelationWhere() {
  return { status: 'ACTIVE' as const, lifecycleState: ACTIVE as string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The stage-clock and dormancy columns a move writes beside the state, so a
 * pause freezes the clock instead of letting it run out while nobody is
 * expected to act:
 *
 *   · pause  — the remaining whole days to `stageDeadline` are kept (negative
 *              when it was already overdue) and the deadline cleared, so no
 *              overdue reminder can fire for a paused pair. Its reminder stamp
 *              is left as it is.
 *   · resume — the deadline is re-derived as now + the same remaining days
 *              (unless a stage move during the pause already set a new one),
 *              and a window that still has days left re-arms its one reminder.
 *              The dormancy episode is cleared: a pause is not silence, and
 *              docs/dormant-first-contacts.md's rule is that any sign of life
 *              resets the stamp and both counters.
 *   · end    — the kept days are dropped; a closed pairing has no clock.
 */
export function stageClockPatch(
  from: RelationLifecycleState,
  to: RelationLifecycleState,
  row: { stageDeadline: Date | null; stageDeadlineRemainingDays: number | null },
  now: Date,
): {
  stageDeadline?: Date | null;
  stageDeadlineRemainingDays?: number | null;
  deadlineReminderSentAt?: null;
  dormantSince?: null;
  dormantNudgeCount?: number;
  dormantNudgeSentAt?: null;
} {
  if (to === PAUSED) {
    if (!row.stageDeadline) return { stageDeadlineRemainingDays: null };
    return {
      stageDeadlineRemainingDays: Math.ceil((row.stageDeadline.getTime() - now.getTime()) / DAY_MS),
      stageDeadline: null,
    };
  }
  if (to === ACTIVE && from === PAUSED) {
    const kept = row.stageDeadlineRemainingDays;
    const restore = kept !== null && row.stageDeadline === null;
    return {
      ...(restore ? { stageDeadline: new Date(now.getTime() + kept * DAY_MS) } : {}),
      ...(restore && kept > 0 ? { deadlineReminderSentAt: null } : {}),
      stageDeadlineRemainingDays: null,
      dormantSince: null,
      dormantNudgeCount: 0,
      dormantNudgeSentAt: null,
    };
  }
  return { stageDeadlineRemainingDays: null };
}
