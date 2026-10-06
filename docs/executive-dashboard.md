# Executive dashboard — `/admin/analytics/executive` (#1895)

Four named scores from 0 to 100 that a sponsor opens, prints on one A4 page and
pastes into a renewal deck. The sibling screen is the programme ROI report
(`docs/roi.md`).

**Deterministic, never predictive.** Every score is `100 × numerator ÷
denominator`, rounded once, over records the customer can open. Nothing is
weighted, learned or extrapolated, and no score is ever labelled a prediction.
The "How is this computed?" affordance on each card shows the sentence below
and the expression for the current period (`100 × 18 ÷ 28 = 64`). The
arithmetic lives in `src/lib/executiveScores.ts` (pure, unit-tested in
`scripts/test/executive-scores.test.mjs`); the counts are loaded by
`src/lib/executiveReport.ts`.

**Premium.** `GET /api/admin/analytics/executive` is ADMIN-only and refuses an
org without `ADVANCED_ANALYTICS` with `403 {code:'feature_locked'}`.

## The denominator: active in the period

A relation counts as active in a period when it started before the period ended
and either is still `ACTIVE` or completed on or after the period's first day. A
relation completed before `completedAt` was recorded has no end date to place it
by and is left out rather than assumed active forever.

## The scores

| Score | Numerator (of the relations active in the period) |
|---|---|
| **Engagement** | had at least one contact in it — the one "contact" rule of `src/lib/lastContact.ts` (#2275): a logged interaction, a direct message either way, or the mentee's own group post (`relationsInContactBetween`) |
| **Progression** | moved **forward** at least one stage on the tenant's main (on-path) order in it; a move to an off-path stage is never progress |
| **Placement** | **first** reached the tenant's resolved finished stage (`outcomeStageKeys`, #1882 — never a literal key) in it |
| **Capability** | <a id="capability"></a>**not measurable yet.** It needs skill proficiency recorded over time (#1822) and the skills-gap report (#1823). Until both exist the card says so; no proxy metric stands in for it. |

## Trend

Each card shows the selected period and the **five equally long periods before
it** (whole days — a 90-day window is compared with the 90 days before it,
never with "last quarter"), as the product's CSS bars, plus one sentence on
the move against the previous period ("Engagement is 4 points below the
previous period"). A period is at most two years long.

## Print

`#executive-print` in `src/app/globals.css`; `e2e/admin-executive.spec.ts`
renders the page to PDF in EN, TR and DE and asserts one page each.
