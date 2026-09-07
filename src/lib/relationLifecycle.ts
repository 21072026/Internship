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
export const RELATION_LIFECYCLE_STATES = ['ENDED_REMATCHED'] as const;

export type RelationLifecycleState = (typeof RELATION_LIFECYCLE_STATES)[number];

/** The mentee asked for a different mentor and an admin approved it. */
export const ENDED_REMATCHED: RelationLifecycleState = 'ENDED_REMATCHED';

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
 * True when this relation was closed by a re-match. Callers use it to keep a
 * re-match out of completion/placement counts and out of certificate
 * eligibility: the pairing ended, the programme did not finish.
 */
export function isRematched(relation: { lifecycleState?: string | null }): boolean {
  return relation.lifecycleState === ENDED_REMATCHED;
}
