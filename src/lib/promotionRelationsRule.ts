// What happens to a person's own mentee relations when they are promoted to
// MENTOR (#1506). Pure and client-safe: both promotion paths (the mentor
// application approval and the admin's role convert, PATCH /api/users/[id])
// and the dialog read one vocabulary.
//
// The maintainer's decision (2026-08-29): never a silent conversion — an admin
// decides. So a promotion of an account with OPEN mentee relations is refused
// until a choice comes with it, and there is no default:
//
//   COACHING — the relations become coaching pairs (#1503): out of the funnel
//              and every placement number, the relation and its history stay.
//   END      — the relations end through the lifecycle (ENDED_EARLY, reason
//              `changed_goals`, a RelationLifecycleEvent): closed, never deleted.
//   KEEP     — nothing changes; the person is a mentor and a candidate at once
//              (right when they really are still looking for a job).
//
// The one choice applies to every open relation of the account; under the
// one-active-mentor rule (#419) that is one relation in practice.

export const PROMOTION_CHOICES = ['COACHING', 'END', 'KEEP'] as const;
export type PromotionChoice = (typeof PROMOTION_CHOICES)[number];

/** The lifecycle reason an END records: the person's goals changed — they mentor now. */
export const PROMOTION_END_REASON = 'changed_goals' as const;

export function isPromotionChoice(value: unknown): value is PromotionChoice {
  return typeof value === 'string' && (PROMOTION_CHOICES as readonly string[]).includes(value);
}

export type PromotionCheck =
  | { ok: true; choice: PromotionChoice | null }
  | { ok: false; code: 'promotion_choice_required' | 'invalid_promotion_choice' };

/**
 * Is this promotion allowed to proceed? A malformed choice is refused whatever
 * the account holds; with no open relation the choice is ignored (null) and the
 * promotion runs exactly as before; with one, a choice is required.
 */
export function checkPromotionChoice(openRelations: number, raw: unknown): PromotionCheck {
  if (raw != null && !isPromotionChoice(raw)) return { ok: false, code: 'invalid_promotion_choice' };
  if (openRelations === 0) return { ok: true, choice: null };
  if (raw == null) return { ok: false, code: 'promotion_choice_required' };
  return { ok: true, choice: raw as PromotionChoice };
}
