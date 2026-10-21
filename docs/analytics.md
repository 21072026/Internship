# Analytics — dimensions, suppression, and what we deliberately do not build

How the reports in the registry (`src/lib/reports/`, [`docs/reports.md`](reports.md))
are sliced, how small groups are protected when they are, and the two analytics
capabilities that are **decided against for now** — written down so the next
person to ask finds the decision instead of re-litigating it (#1919, #1920).

## Dimensions (#1920)

A *dimension* is an attribute an organisation defines for its people —
a department, a level, a location, a start date — and that a report can be
sliced by. There are two models, both tenant data (`orgId` + `TENANT_MODELS`):

| Model | What it is |
|-------|------------|
| `OrgAttribute` | The definition: a stable `key` (`[a-z][a-z0-9_]{0,63}`, fixed once created), the admin's own label in EN/TR/DE (columns, not dictionary keys — the admin wrote them), a `type` (`SELECT` \| `TEXT` \| `DATE` \| `NUMBER`), a `SELECT`'s `options`, `isSegmentable`, `sortOrder`. `@@unique([orgId, key])`. |
| `UserAttributeValue` | One person's value of one attribute, normalised per type (`src/lib/orgAttributesRule.ts`). `@@unique([userId, attributeId])`; `@@index([orgId, attributeId, value])` is what makes a segmented report one grouped query rather than a scan. |

- **Where definitions are made:** `/admin/attributes` (`/api/admin/attributes`):
  define, label, set options, reorder, mark segmentable, and see how many people
  carry a value.
- **Where values come from:** the admin import (an attribute-value mode on the one
  import engine, `runImport()` in `src/lib/importPreview.ts`). An HRIS connector is
  not a dependency; the scheduled roster feed ([`docs/roster-feed.md`](roster-feed.md))
  is the scheduled path.
- **Vocabularies are VARCHAR + a whitelist in code**, never a Prisma enum (#747).
  `appliesTo` is `USER` today; `RELATION` is reserved and refused on write.
- **Type and key are fixed after creation.** Changing either would silently
  reinterpret every value already stored.
- **Tenure is derived, never stored.** A `DATE` attribute (a start date) is bucketed
  at read time — under 1 year, 1–3, 3–5, 5 or more (`tenureBucket()`). A stored
  tenure is wrong the day after it is written.
- **Deleting an attribute** that a saved view or a report subscription slices by
  answers `409 referenced` with the counts first; confirmed, it deletes the
  attribute and its values and rewrites those views and subscriptions to the
  unsliced report, in one transaction. The report loader treats an unknown
  `segmentBy` as unsliced too, so a stale reference can never 500 a scheduled send.

### No special-category presets — and why

The attribute vocabulary is generic on purpose, and **the admin UI ships no
presets** — above all none for special-category data (ethnicity, disability,
gender, health, religion; GDPR Art. 9). The admin screen says so next to the list.

Special-category data needs **separated storage and its own access control**
before a single row is collected, and that decision has not been made.
`UserAttributeValue` is ordinary tenant data, readable by every admin of the org.
A generic attribute an admin chooses to misuse is that customer's decision; a
preset we ship would be our recommendation to collect it.

## Suppression after the split

The registry's privacy floor (`src/lib/reports/privacyFloor.ts`, `minCohort`,
default 5, never lowered) folds every group smaller than the floor into one named
bucket instead of dropping it, so the totals still reconcile.

Segmentation multiplies small groups: "conversion per cohort" is safe at the
cohort level and identifying at "per cohort, for the Munich office". So when a
report is sliced, the floor is applied **after** the segment split — to every
segment the reader would see — never only to the unsliced total, where it would
protect nobody. Segments under the floor go into ONE named "below reporting
threshold" bucket — together with the people who have no value, when that group is
small too — and are never silently omitted. The bucket is shown even when it is itself
under the floor, like the registry's own bucket: its members cannot be told apart. A
single segment requested on its own (`&segment=`) that is under the floor is answered
`suppressed: true` with a note, not with an empty table. Inside every shown segment the
report's own floor runs again on its groups.

## Slicing a report (`segmentBy`)

`GET /api/admin/reports/[key]?segmentBy=<attribute key>` — the **groupBy** variant: one
block of rows per segment, with a leading `segment` column (JSON, CSV and XLSX alike).
Add `&segment=<value>` (for a `DATE` attribute: a tenure bucket, `lt1y` … `gte5y`) for
one segment only. `/admin/reports` is the screen; a report subscription can store the
same slice (`segmentBy`, `segment` in its `params`) and the scheduled send honours it.

- **One mechanism, in the registry.** A definition that names a `segmentSubject`
  (`mentee` or `mentor`, `src/lib/reports/definitions.ts`) is sliceable; `loadReport()`
  turns each segment into a filter on that person — a relation subquery
  (`attributeValues: { some: … }`), never an id list — and runs the report's own loader
  under it. Today: pipeline funnel and summary, cohort comparison, source conversion,
  mentor workload, placement outcomes and weekly-report compliance.
- **Query count.** Planning is 3 queries (the attribute, one grouped value count over
  the report's subject people, one "no value" count); then the loader's own queries once
  per shown segment. At most 12 segments are shown, plus "other values", "no value" and
  the below-threshold bucket, so the count is bounded whatever the org's size.
- **Every person is in exactly one segment** (`planSegments()`, unit-tested in
  `scripts/test/report-segments.test.mjs`), so the segments add up to the unsliced total.
- **Degrades, never fails.** An unknown or non-segmentable `segmentBy` returns the
  unsliced report with `segmentIgnored`.

## Deliberately deferred

Both are **decided against for this year**, not overlooked.

### DEI and representation analytics

Representation and outcome breakdowns by ethnicity, disability, gender or any other
special-category attribute.

*Why not:* it is downstream of a survey/attribute collection path for that data and
of the special-category storage decision above (separated storage, its own access
control), neither of which exists.

*Unblocks when* all three hold: a collection path for the data exists, the
special-category storage and access-control decision has been made and built, and a
named customer requires it in writing.

### Retention and internal-mobility comparison (participants vs non-participants)

Whether people who went through the programme stay longer or move internally more
often than people who did not.

*Why not:* it needs employment records for people who are **not** in the programme —
an HRIS join. HRIS connectors were judged whole-product-sized; scheduled CSV/SFTP
ingestion was recommended instead.

*Unblocks when* that ingestion path carries a non-participant roster (the scheduled
roster feed, `docs/roster-feed.md`, is the candidate) and a customer supplies one.
