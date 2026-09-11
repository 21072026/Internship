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

/** Lifecycle end states a relation can carry. */
export const RELATION_LIFECYCLE_STATES = ['ENDED_REMATCHED', 'ENDED_REASSIGNED'] as const;

export type RelationLifecycleState = (typeof RELATION_LIFECYCLE_STATES)[number];

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
