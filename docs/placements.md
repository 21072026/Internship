# The placement ledger (#1765)

A `Placement` is the billable fact behind a hire: which company, which role, on
what date, credited to which mentor and which source, and whether it has been
invoiced. `StatusChange` is a log and stays one; the ledger is the record.

## How a row is stamped

- Every stage write path already ends in `emitStageChange()`, which emits
  `pipeline.stage_change`. The **`placement` subscriber**
  (`src/lib/events/subscribers/placement.ts`) runs on the job worker and calls
  `syncPlacementForRelation()` (`src/lib/placementLedger.ts`) — the only code
  that creates, reverses or reinstates a row.
- It **reconciles**: it reads the relation's *current* stage and asks the pure
  `reconcilePlacement()` (`src/lib/placementRule.ts`) what the ledger should
  say. A redelivered, duplicated or out-of-order event converges on the same
  row; `Placement.relationId` is unique, so a concurrent double-create is one row.
- The hire stages are the org's own `outcomeStageKeys().finished` (#1882) — never
  a hardcoded `HIRED_660`, because tenants define their own stages (#747).
- Skipped: a vertical without the `placements` capability (a sale is not a hire),
  a `COACHING` relation (#1503), a relation with no org.
- It **observes only**: no stage move, no relation status change, no notification.

## What a row carries

company (the relation's, else the accepted offer's), `offerId` + `requisitionId`
(the newest ACCEPTED offer), `creditedMentorId` (the relation's mentor), `sourceId`
(the mentee's), `attribution` (the relation's `employmentAttribution`, NULL read as
`THROUGH_US`). The attribution columns are plain ids, not FKs: the record outlives
what they point at.

`THROUGH_US` starts `INVOICEABLE`; `SELF_FOUND` / `ALREADY_EMPLOYED` start
`NOT_INVOICEABLE` with `feeModel: NONE` — the row exists because honest reporting
needs it.

## Reversal

Leaving the hire stage sets `reversedAt`; a return clears it. **A placement is
never deleted.** Reversed rows are hidden from the ledger by default and ignored
by the ROI report and the `placement-outcomes` report.

## Invoice states

`NOT_INVOICEABLE → (none)`, `INVOICEABLE → INVOICED | WAIVED`,
`INVOICED → INVOICEABLE`, `WAIVED → INVOICEABLE` (`canChangeInvoiceState()`).
`INVOICED` needs an invoice reference and a live (not reversed) hire.
`PATCH /api/admin/placements/[id]` is `org.settings.write` (ORG_ADMIN), writes with
a guarded `updateMany` (409 `state_conflict` on a race) and an `AuditLog`
`PLACEMENT_INVOICE_STATE` row with `orgId`.

## Not in scope

No public per-hire fee page: placement/brokerage rules in DE and TR need a legal
check first. No usage counter yet.

## What a placement NUMBER counts (#1504)

Every analytics reader that counts placements reads one rule, `src/lib/placement.ts`:
`countsAsPlacement()` in memory, `PLACEMENT_RELATION_WHERE` + `OUR_HIRE_WHERE` in SQL, on top of
the tenant's own finished stages (`outcomeStageKeys()`).

- **COACHING relations leave both sides of a placement rate and the funnel** — their stage means
  nothing to a hiring funnel. A mentor's *workload* still counts every pairing.
- **A hire is ours when it came `THROUGH_US` or says nothing** (NULL, every row from before #1503).
  `SELF_FOUND` / `ALREADY_EMPLOYED` stay in the denominator as placement relations, but are not
  placements; in a cohort row they are neither hired nor in progress.
- With every relation `PLACEMENT` and no attribution stated, every number is exactly what it was —
  `e2e/placement-counts.spec.ts` pins that.

Readers on the rule: the admin analytics screen (`adminAnalyticsData.ts`: funnel, total,
conversion, mentor workload), programme/cohort comparison (`analyticsReports.ts`), benchmark,
source conversion (both `/api/admin/analytics/sources` and `/api/admin/sources`) and the mentor's
own analytics.
