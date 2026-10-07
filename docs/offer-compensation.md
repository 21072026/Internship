# Structured compensation on offers (#1851)

`Offer.compensationNote` was the entire model of pay: prose, invisible to any
report. This adds the figures beside it and the one read model they feed.

## The columns

| Column | Meaning |
|---|---|
| `currency` | ISO 4217, from the closed list `OFFER_CURRENCIES` (EUR, TRY, USD, CHF, GBP) |
| `baseAmountMinor` + `basePeriod` | base pay in **minor units** (4 500 00 = €4 500.00) per `HOURLY` / `MONTHLY` / `YEARLY` |
| `hoursPerWeek` | what an hourly rate is multiplied by; also plain information on a part-time contract |
| `contractType` | `INTERNSHIP` / `WORKING_STUDENT` / `FIXED_TERM` / `PERMANENT` |
| `signingBonusMinor`, `otherBonusMinor` | one-off amounts in the same currency |
| `equityNote` | free text — equity is not a number we pretend to normalise |
| `compensationNote` | **stays**: the free-text elaboration, not replaced |

Integer minor units + a code, never a `Float` or a `Decimal`: the rule the
schema states at `ProgramCost` / `Placement` ("MONEY IS ALWAYS AN INTEGER IN
MINOR UNITS"), and the reason the issue's `Decimal(12, 2)` sketch was not
followed. `basePeriod` and `contractType` are Strings validated against the
whitelists, not enums — a `db push` enum change is DROP + CREATE.

## The rules (`src/lib/compensation.ts`, pure, unit-tested)

- **An amount needs a currency and a period; a bonus needs a currency.**
  `validateCompensation()` is called on POST with the full set and on PATCH with
  the *merged* set (`src/lib/compensationInput.ts`), so `{ basePeriod: null }`
  against a stored amount is refused rather than leaving a number that means nothing.
- **`normalizeToMonthlyMinor()` is for comparison, never stored.** Monthly as is,
  yearly ÷ 12, hourly × hours × 52 ÷ 12 — and an hourly rate **without hours is
  `null`**, not "assume 40". Rounded half away from zero like `roi.ts`.
- **Visibility is one list.** `OFFER_COMPENSATION_FIELDS` (`src/lib/offers.ts`)
  is what the routes build their conditional `select` from, behind the existing
  `canSeeCompensation()` — ADMIN and the offer's own MENTEE; COMPANY never
  receives a column from it. `e2e/offers.spec.ts` asserts a COMPANY body carries
  none of them, so a column added to the schema but not to the list is red.
- **The benchmark suppresses, it does not omit.** `GET /api/admin/offers/benchmark`
  (ADMIN, tenant-scoped) groups ACCEPTED offers by position × currency — the model
  never converts currencies — and returns count / median / p25 / p75 (R-7
  interpolation) of the monthly base. A bucket under `BENCHMARK_MIN_BUCKET` (5)
  is returned with `null` figures and `suppressed: true`: a median over two rows
  is those two people's pay. `?by=contractType` adds the type as a third key.
  Nothing is stored; it is derived per request from the offers (bounded scan).

## Where the code is

| File | Role |
|---|---|
| `prisma/schema.prisma` | the columns on `Offer`, `@@index([orgId, currency])` |
| `src/lib/compensation.ts` | whitelists, validation, normalisation, quantiles, buckets |
| `src/lib/compensationInput.ts` | the zod shape the routes share, merge for PATCH |
| `src/lib/offers.ts` | `OFFER_COMPENSATION_FIELDS`, `compensationSelect()` |
| `src/app/api/offers/route.ts`, `…/[id]/route.ts` | write + conditional read |
| `src/app/api/admin/offers/benchmark/route.ts` | the read model |
| `src/components/CompensationSummary.tsx` | the one renderer (wizard preview, admin panel, candidate card) |
| `src/components/OfferBenchmarkCard.tsx` | the collapsed card on `/admin/offers` |
| `scripts/test/compensation.test.mjs`, `e2e/offer-compensation.spec.ts` | the rules and the routes |

No backfill: existing `compensationNote` prose is not parsed into numbers.
`Placement.valueSource = 'OFFER_COMP'` is still unused — nothing in the tree
creates a `Placement` from an offer yet; when something does, the figure to take
is `normalizeToMonthlyMinor()` of the accepted offer, in its own currency.
