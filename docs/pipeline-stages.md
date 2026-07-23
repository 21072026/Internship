# Per-tenant pipeline stages (#747)

Making the mentee pipeline stages tenant-configurable — the heaviest part of the
white-label track (#546), split out from it. Delivered in safe, gated slices so
single-tenant production is never at risk.

## Slices

| Slice | What | State |
|-------|------|-------|
| A (foundation) | `PipelineStage` model + resolution layer + admin API | **done** |
| A.2 | Admin UI to edit stages (label / order / color / on-path) | planned |
| B | Apply resolved stages across board / filters / analytics / journey / bulk-advance | planned |
| C | Move storage off the enum (`MentorshipRelation.pipelineStatus` enum → String) so tenants can define **new** stage keys, with a data-safe migration | planned |

## How it works (Slice A)

- **`PipelineStage`** (per org): `key`, `label`, `order`, `isTerminal`,
  `isOffPath`, `color`. `@@unique([orgId, key])`.
- **`resolvePipelineStages(orgId, locale)`** (`src/lib/pipelineStages.ts`):
  returns the org's rows if any, else `defaultPipelineStages()` — the canonical
  13 stages derived from the `PipelineStatus` enum (single source of truth in
  `src/lib/pipeline.ts`). An org with **no** rows behaves exactly as today.
- **`onPathKeys(stages)`**: the happy-path sequence (excludes off-path), for
  "advance one stage" semantics over a resolved set.
- **Admin API** `/api/admin/organizations/[id]/pipeline-stages`
  (`GET` / `PUT` / `DELETE`): admin-only; `PUT` is **premium-gated** (a paid
  plan) and replaces the whole set atomically; `DELETE` resets to the built-in
  defaults.

## Why relations still use the enum in Slice A

Changing `MentorshipRelation.pipelineStatus` from a Prisma enum to a free string
(Slice C) is a cross-cutting change (every pipeline surface + a prod migration).
Doing labels/order/color first (over the canonical keys) delivers most of the
white-label value with zero storage risk; brand-new tenant-defined keys come in
Slice C. The MySQL `ENUM → VARCHAR` change preserves existing values (the enum is
stored as its label string), so Slice C's migration is data-safe, but it is
sequenced last and verified on preview before prod.
