// Is a REJECTED mentor application's `rejectReason` actually the reason? (#1806)
//
// Before the note/reason split, the admin UI's "save note" action wrote to
// `rejectReason` — the same column the reject action uses. So on a row that was
// rejected before the split, the surviving text is EITHER the reason the admin
// recorded for the decision OR a private review note saved afterwards that
// destroyed that reason. Nothing on the row distinguishes the two cases, which
// is why prisma/backfill-mentor-application-admin-note.mjs deliberately leaves
// those rows alone instead of guessing.
//
// The UI has to be equally careful. Presenting that text as "the recorded
// rejection reason" would state, on the CRM's own authority, that a private
// note was the reason a person was turned down — the exact fabrication the
// backfill refuses to commit, just moved into the label.
//
// A date is the only discriminator available: a row decided from this instant
// on was written by code in which the note action cannot reach `rejectReason`.
// The constant is rounded UP to the day after the fix shipped on purpose.
// Over-flagging a handful of correct rows costs one hedging sentence for less
// than a day; under-flagging restates the defect.
export const REJECT_REASON_TRUSTED_FROM = Date.parse('2026-09-07T00:00:00Z');

/**
 * True when the row's `rejectReason` cannot be trusted to be a rejection reason
 * and must therefore not be labelled as one. Only REJECTED rows display the
 * field at all; an undated decision counts as ambiguous, because nothing proves
 * it postdates the split.
 */
export function isRejectReasonAmbiguous(
  status: string,
  decidedAt: string | Date | null | undefined,
): boolean {
  if (status !== 'REJECTED') return false;
  if (!decidedAt) return true;
  const decided = typeof decidedAt === 'string' ? Date.parse(decidedAt) : decidedAt.getTime();
  if (!Number.isFinite(decided)) return true;
  return decided < REJECT_REASON_TRUSTED_FROM;
}
