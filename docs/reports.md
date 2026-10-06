# Report registry (#1903)

Every exportable report is a **named definition** in one place instead of a
row-builder hand-written inside the screen that shows it. A definition says
what the report is called, which columns it has and what type each column is;
the registry loads its rows, applies the privacy floor and renders it as JSON,
CSV or XLSX.

| File | Role |
|------|------|
| `src/lib/reports/definitions.ts` | The catalogue (pure, client-safe): key, i18n keys, columns, floor settings, capability |
| `src/lib/reports/privacyFloor.ts` | `applyMinCohort` — the floor itself (pure, unit-tested) |
| `src/lib/reports/registry.ts` | Server side: one loader per key, `loadReport(def, ctx)` |
| `src/lib/reports/render.ts` | Localized labels, bucket name, CSV — shared by the route and the workbooks |
| `src/lib/reports/workbooks.ts` | The export workbooks' sheets (analytics, full report, candidates) |
| `src/app/api/admin/reports/[key]/route.ts` | `GET ?format=json\|csv\|xlsx` |
| `scripts/check-reports.ts` | CI guard (`npm run check:reports`) |

## Access

- ADMIN only, tenant-scoped like every analytics route (`tenantWhere`).
- `format=json` needs `ADVANCED_ANALYTICS`; `csv` / `xlsx` additionally need
  `REPORT_EXPORT`. A locked call answers `403 { code: 'feature_locked', feature }`.
- A report tagged with a `capability` (e.g. `mentorship`, `placements`) is a
  **404** for an org whose vertical does not carry it — the report does not
  exist for that tenant, it is not merely locked.
- An unknown key is a 404, a bad `format` a 400.

## The privacy floor

An aggregate report (one row per group: a cohort, a source, a company) must not
let a reader single out a person. Any group with fewer than `minCohort` people
is therefore **merged** into one bucket labelled "Groups under N people
(combined)" (`SUPPRESSED_LABEL` in the data, localized on output).

Rules, all enforced in `applyMinCohort`:

- **The default is 5 and is never lowered.** A definition may raise its own
  `minCohort`; `check:reports` fails a value below `DEFAULT_MIN_COHORT`.
- **Totals reconcile.** `number` columns of the merged groups are summed into
  the bucket, so the report's column totals are identical with and without the
  floor — a reader can still trust the bottom line.
- **Derived columns are not recomputed.** `average`, `percent` and `string`
  columns are `null` in the bucket: an average over a mix of unrelated groups
  means nothing, and recomputing a rate from summed parts would publish a
  number nobody chose.
- **The bucket is emitted even when it is itself under the floor.** Dropping it
  would break the reconciliation; a single merged bucket no longer names a group.
- Row-level reports (`aggregate: false` — a funnel, a per-mentor or per-intern
  list the admin can already see row by row in the product) are not floored.

Every response says what happened: JSON carries
`privacyFloor: { minCohort, suppressedGroups, bucketLabel, note }`, and CSV/XLSX
append the note as a trailing line when anything was merged.

## The export workbooks

`GET /api/admin/export/[dataset]` (#1740) returns **finished sheets**
(`{ sheets: [{ name, columns, rows }] }`) built by `workbooks.ts`; the screens
only pass them to `src/lib/excel.ts`, which keeps SheetJS code-split. No page
component builds report rows any more, and the candidate list's CSV is a file
from the route (`?format=csv`).

- The sheets that are named reports — Funnel, Mentors, Cohorts, Sources — are
  loaded through the registry, so the workbook and the single-report download
  cannot disagree and **the cohort and source sheets carry the privacy floor**.
  A sheet whose module the vertical lacks is left out.
- The KPI tables (conversion, time to hire, trials, capacity, trends, drop
  reasons) are screen-specific and live in `workbooks.ts` as plain builders.
- `analytics-full` is refused as a whole (`403 feature ADVANCED_ANALYTICS`)
  without the premium tier, instead of handing out a workbook with holes.
- `/admin/analytics` footnotes the floor under the premium cards
  (`data-testid="report-floor-footnote"`): the cards show the admin every
  group, the exported files do not.

## Adding a report

1. Add the definition to `REPORT_DEFINITIONS` (kebab-case key, column types).
   An aggregate report must name a `number` `sizeColumn` and a `string`
   `labelColumn`.
2. Add `async '<key>'(ctx) { … }` to `LOADERS` in `registry.ts`. Reuse the
   screen's own route in-process (`import { GET as xGET }`) rather than copying
   its query — two copies of a metric drift.
3. Add the title, description and any new `col.*` labels to the `reports`
   block of all three dictionaries; if a label names a mentor/intern, add the
   MARKETING wording to `src/i18n/verticalOverlays.ts` (the i18n leak ratchet
   will tell you).
4. `npm run check:reports && npm run check:i18n`.
