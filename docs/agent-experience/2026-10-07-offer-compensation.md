## 2026-10-07 — structured compensation on offers + benchmark (#1851)

- **Read the schema's own money note before following an issue's column sketch.** #1851 asked
  for `Decimal(12, 2)`; `prisma/schema.prisma` (at `ProgramCost`) says "MONEY IS ALWAYS AN
  INTEGER IN MINOR UNITS plus an ISO 4217 code. No Float, no Decimal-as-string", and
  `src/lib/money.ts` formats only minor units. Followed the repo rule and said so in the issue
  comment and the PR; the issue text predates #1892.
- **A visibility rule that lives in a `select` needs a LIST, not a second `select`.** The note
  was `{ ...baseSelect, compensationNote: true }` in two routes; eight more columns under the
  same rule would have been eight chances to forget one. `OFFER_COMPENSATION_FIELDS` +
  `compensationSelect()` in `src/lib/offers.ts`, and the COMPANY e2e iterates the list.
- **Validate a PATCH as the merged set.** `{ basePeriod: null }` alone is a valid patch and an
  invalid row. Read the stored fields, merge, validate the merge (`compensationInput.ts`).
- **Stale `.next/types` from a different branch breaks `tsc --noEmit`** after a branch switch
  in the same clone (`validator.ts` imports pages that no longer exist). `rm -rf .next` first.
- **`parseMinorUnits` (money.ts) already accepts both `2.500,00` and `2,500.00`**; reuse it in
  any amount input rather than `Number(value) * 100` (which floats).
