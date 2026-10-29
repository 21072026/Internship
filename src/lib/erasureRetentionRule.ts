// How long the two records that an erasure deliberately KEEPS outlive the
// person (#2098). Pure (no imports), so the unit test
// (scripts/test/erasure-retention.test.mjs) pins every date without a database;
// the sweeps that apply it are the `contactPermissionProof` and
// `affiliatePayoutDetails` entries in src/lib/retentionEntries.ts.
//
// The two records, and the decision the rights holder took for each:
//
//   ContactPermission (UWG § 7 proof) — THREE years. The proof exists to answer
//     a claim that a mail went out without permission. The data subject's own
//     claim (§§ 823, 1004 BGB) has the regular limitation period of three years
//     (§ 195 BGB). The clock starts at the ERASURE: from that moment no mail can
//     reach the person any more, so the last mail the proof may ever have to
//     justify was sent before it. A revocation earlier than the erasure does not
//     move the start forward — mail sent before the revocation is exactly what
//     the proof covers, and the erasure is the later, safe end of that span.
//
//   AffiliatePartner.payoutDetailsCipher (IBAN, account holder) — TEN years
//     (§ 257 Abs. 4 HGB, § 147 Abs. 3 AO: Buchungsbelege). The duty attaches to
//     the bookings, not to the account, so the clock starts at the END OF THE
//     RELATIONSHIP — the latest of the account erasure, the termination taking
//     effect (`noticeEffectiveAt`) and the last payout made to those details.
//     A partner whose account was erased but who was paid later still has
//     bookings that point at the IBAN; starting at the erasure alone would
//     delete the details while a booking that used them is still in its period.
//
// Both periods begin at the END of the calendar year in which the anchor falls
// (§ 199 Abs. 1 BGB; § 257 Abs. 5 HGB, § 147 Abs. 4 AO), so a record anchored
// any day in 2026 expires on 1 January of 2026 + N + 1. Everything is UTC; the
// year boundary is off by a few hours at most against German local time, and
// always on the late side of it for the sweep, which runs after midnight UTC.

export const CONTACT_PROOF_RETENTION_YEARS = 3;
export const PAYOUT_DETAILS_RETENTION_YEARS = 10;

/** The instant a record anchored at `anchor` may go: 1 January (UTC) of anchorYear + years + 1. */
export function retainedRecordExpiry(anchor: Date, years: number): Date {
  return new Date(Date.UTC(anchor.getUTCFullYear() + years + 1, 0, 1));
}

/**
 * The SQL side of the same rule: a record has expired at `now` exactly when its
 * anchor is STRICTLY before this instant (1 January of nowYear − years).
 * `retainedRecordExpiry(anchor) <= now` ⇔ `anchor < retainedRecordCutoff(now)`;
 * the unit test checks the two against each other across year boundaries.
 */
export function retainedRecordCutoff(now: Date, years: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear() - years, 0, 1));
}

/**
 * The anchor of an affiliate partner's payout details: the latest of the three
 * ends of the relationship, or null while the account has not been erased (a
 * living partner's details are theirs to change, and no clock runs).
 */
export function payoutDetailsAnchor(input: {
  accountErasedAt: Date | null;
  noticeEffectiveAt: Date | null;
  lastPaidAt: Date | null;
}): Date | null {
  if (!input.accountErasedAt) return null;
  let anchor = input.accountErasedAt;
  for (const d of [input.noticeEffectiveAt, input.lastPaidAt]) {
    if (d && d.getTime() > anchor.getTime()) anchor = d;
  }
  return anchor;
}
