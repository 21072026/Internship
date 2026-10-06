# Programme ROI — `/admin/analytics/roi` (#1895)

One screen a sponsor opens, prints on one A4 page and pastes into a renewal deck:
the return on investment, **every step that produced it**, and every assumption
behind it with its value and the reason it is there.

- **One model.** The arithmetic is `computeRoi()` in `src/lib/roi.ts` (#1892) —
  Prisma-free, clock-free, integer money only — shared with the public
  calculator (#1755). There is no second assumption set anywhere.
- **Premium.** `GET /api/admin/analytics/roi` is ADMIN-only and refuses an org
  without `ADVANCED_ANALYTICS` with `403 {code:'feature_locked'}` — at the API,
  not by hiding a button. Basic analytics stay free.
- **Deterministic.** Nothing is predicted, learned or modelled. Each step shows
  its expression (`1200000 / 2 = 600000`), in minor units, unlocalised on
  purpose: it is the calculation, not prose.

## Which rows fall in a window

The selection lives in `src/lib/roiReport.ts`; `roi.ts` only adds up what it is
given.

**Costs.** Every `ProgramCost` line whose period **overlaps** the window counts
**in full** — the ledger's own contract (`prisma/schema.prisma`, "additive by
construction"). No proration, so every figure is a sum of rows an admin can
open; an annual licence seen through a one-month window reads as the whole
year's spend, and the screen says so. A cohort filter keeps that cohort's lines
only (org-wide lines carry no cohort).

**Placements.** A relation is placed in the window when

1. its `Placement` row's `placedAt` is in the window, or
2. it has **no** `Placement` row at all and it **first** entered the tenant's
   resolved finished stage (`outcomeStageKeys`, #1882 — never a literal key)
   inside the window.

"First", so a relation that bounced out of the stage and back in is one hire,
and a hire from two years ago touched again this month is not counted again.
Value comes only from a `Placement` row; a relation without one is valued from
the assumptions, and the screen states how many were (`placementSources`,
`assumedPlacements`) — an estimate is never shown as a measurement.

## Currency

The assumptions are denominated in the window's own currency: the one picked on
the screen (`?currency=`), else the one every cost line shares, else the first
recorded placement value's, else EUR. A window whose lines really mix
currencies is **not** summed: the model returns `mixed_currency` with the list,
the screen says so in a sentence and offers the currency filter.

## Assumptions

`unfilledRoleCostPerMonthMinor`, `vacancyMonthsAvoidedPerPlacement`,
`recruiterFeeAvoidedPerPlacementMinor`, `mentorHourValueMinor` and
`mentorHours` (unbilled mentor hours to price; default 0) are editable on the
screen as **query state** — nothing is saved. Each is shown with its default and
one line on why it is there; the defaults and their reasoning are documented in
`src/lib/roi.ts`.

## Print

`#roi-print` in `src/app/globals.css` fits the page to one A4 sheet. German is
the longest locale, so nothing has a fixed width — the type and spacing
tighten instead. `e2e/admin-roi.spec.ts` renders the page to PDF in EN, TR and
DE and asserts one page each.
