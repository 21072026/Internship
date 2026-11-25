// Contact or attempt? — one rule for an interaction log's outcome (#3902).
//
// A call nobody answered used to leave no trace, so "how often was this lead
// tried" was invisible. It is now a log like any other, with
// `outcome = NOT_REACHED`: an ATTEMPT. Every row written before (and every
// contact since) is `REACHED` — the column's database default — so no backfill
// was needed and nothing old changed meaning.
//
// ── WHAT AN ATTEMPT IS NOT ──────────────────────────────────────────────────
//
// An attempt is not contact. The readings that ask "was there contact" read
// REACHED rows only, through `CONTACT_INTERACTION_WHERE`:
//
//   * last contact (src/lib/lastContact.ts, docs/last-contact.md) — an
//     unanswered call must not silence "no recent contact";
//   * the first-contact stage advance (#3746, src/lib/firstContactAdvance.ts) —
//     nobody was reached, so the lead has not been contacted;
//   * the interaction COUNTS shown as "interactions" (dashboards, reports,
//     analytics) — they count contacts; attempts are counted on their own.
//
// ── WHAT AN ATTEMPT STILL IS ────────────────────────────────────────────────
//
//   * outreach, to the dormant-first-contact rule (src/lib/dormantFirstContact.ts):
//     that rule never resets on a log — only the lead's own sign of life does —
//     and reads a log as "somebody reached out and heard nothing back", which is
//     exactly what an unanswered call is;
//   * activity, to the billing meter (src/lib/meteringRules.ts): work logged on
//     a record is activity whether or not the phone was picked up.
//
// Only a Call or a WhatsApp can be unanswered; an e-mail, a meeting or a piece
// of feedback that happened is contact by its nature, so the write paths refuse
// NOT_REACHED on them (400 `outcome_not_allowed`).
//
// Dependency-free (no `@/` imports, no Prisma runtime) so a unit test can import
// it under plain `node --experimental-strip-types`.

export const INTERACTION_OUTCOMES = ['REACHED', 'NOT_REACHED'] as const;
export type InteractionOutcome = (typeof INTERACTION_OUTCOMES)[number];

/** The types a person can try and fail to reach someone with. */
export const ATTEMPTABLE_TYPES = ['Call', 'WhatsApp'] as const;

export function canBeAttempt(type: string): boolean {
  return (ATTEMPTABLE_TYPES as readonly string[]).includes(type);
}

/** Is this row an attempt rather than contact? A missing outcome is contact (pre-#3902). */
export function isAttempt(row: { outcome?: string | null }): boolean {
  return row.outcome === 'NOT_REACHED';
}

/**
 * May this type carry this outcome? REACHED always; NOT_REACHED only on a
 * Call or a WhatsApp.
 */
export function outcomeAllowed(type: string, outcome: InteractionOutcome | null | undefined): boolean {
  return outcome !== 'NOT_REACHED' || canBeAttempt(type);
}

/**
 * The Prisma `where` of "a log that is contact". `outcome` is a required
 * column with a default, so a plain equality is exact (no NULL to fall through
 * a `not`).
 */
export const CONTACT_INTERACTION_WHERE = { outcome: 'REACHED' } as const;

/** …and of "an attempt". */
export const ATTEMPT_INTERACTION_WHERE = { outcome: 'NOT_REACHED' } as const;
