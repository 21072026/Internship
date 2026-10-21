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

## Forecast and capacity (#1897)

The panel under the scores is the current conversion carried forward, with the
multiplication shown. It is not a prediction model: nothing is fitted or
trained, and nothing is compared with other installations. The arithmetic is in
`src/lib/forecast.ts` (pure, `scripts/test/forecast.test.mjs`) and the read is
in `GET /api/admin/analytics/forecast?horizon=YYYY-MM-DD` (ADMIN,
`ADVANCED_ANALYTICS`).

- **Step rates.** Conversion from each on-path stage onward, over the journeys
  (transfer chains, #2556) that started in the last 365 days. An open journey
  counts only for the stages it has already left (`resolvedConversions`). A
  candidate still deciding stage k is not a "did not advance".
- **Dwell.** The median days actually spent in each stage, over visits that
  ended in the same year (`computeStageAging`, the aging report's rule).
- **Placements.** For each stage, today's ACTIVE records × the product of the
  remaining step rates up to the tenant's finished stage (`outcomeStageKeys`,
  #1882). A stage counts only when its summed median dwell to the finish fits
  inside the horizon. Time already spent in a stage is not subtracted, so the
  test errs towards "not yet".
- **Band.** The same arithmetic with every step rate moved down and up by one
  standard error of its own history (√(p(1−p)/n)). It shows how sensitive the
  figure is, not a confidence interval.
- **Floor.** If any stage the projection multiplies through has fewer than
  **10** journeys (`MIN_JOURNEYS_PER_STAGE`), the panel names those stages and
  does not project.
- **Capacity** (only where the vertical carries `mentorship`). Each record
  reaches a later stage with the product of the rates in between, arrives
  after the summed dwells, and then needs a mentor seat for that stage's
  median dwell or until the horizon, whichever comes first. The stages are
  summed in pipeline order against *stated seats × horizon days*. The
  bottleneck is the first stage where the running total exceeds that. The
  extra mentors are the shortfall ÷ (average stated capacity × horizon days),
  rounded up. If no mentor has stated a capacity, the panel says it cannot be
  worked out.
