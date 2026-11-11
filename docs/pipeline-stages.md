# Per-tenant pipeline stages (#747)

Making the mentee pipeline stages tenant-configurable — the heaviest part of the
white-label track (#546), split out from it. Delivered in safe, gated slices so
single-tenant production is never at risk.

## Slices

| Slice | What | State |
|-------|------|-------|
| A (foundation) | `PipelineStage` model + resolution layer + admin API | **done** |
| A.2 | Admin UI to edit stages (label / order / color / on-path) | **done** |
| C | Move storage off the enum (`MentorshipRelation.pipelineStatus` enum → String) so tenants can define **new** stage keys, with a data-safe migration | **done** |
| B | Apply resolved stages across journey / board / filters / analytics + accept dynamic keys on the write path | **done** |

### Slice B — what renders resolved stages
Every stage-rendering surface now reads the viewer tenant's resolved stages via a
server-fed client context (`PipelineStagesProvider` in the admin/mentor/company/
portal layouts) + `useResolvedStages()`/`useStageLabel()`, or server-side
`resolvePipelineStages()` on server pages: the mentee **journey**, admin & mentor
**kanban boards**, the candidate **filter** + list + export, and the admin/mentor/
company **analytics funnels** + dashboards. The write path (`PUT /api/mentorship/[id]`,
`POST /api/status-changes`) accepts free-string stage keys so custom stages can be
assigned.

### Known limitations (canonical-model, acceptable for now)
- The kanban board's **three-phase grouping** (`PIPELINE_GROUPS`: pre / internship /
  result) is the canonical model. Relabels/reorder/colors show through; a tenant's
  brand-new keys that aren't among the canonical set won't appear under a phase
  group (they still work everywhere else). Per-tenant grouping is a future refinement.
- **Bulk "advance stage"** advances along the canonical on-path order
  (`nextOnPathStatus`); for a fully custom key set it no-ops rather than guessing.

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

## Stage entry gates (#1589)

A tenant can state, per stage, what must hold before a relation moves
**forward** into it — four columns on `PipelineStage`, all off by default:

| Column | Refuses the move unless |
|---|---|
| `gateCapability` | the mover holds this `Permission` (`src/lib/authzRule.ts`) on the relation — e.g. `pipeline.transition`, which no MENTOR holds. An unknown name refuses every forward move (fail-closed). |
| `gateDocuments` | the mentee has no unmet **mandatory** document requirement that applies at the target stage (`missingRequirementsAtStage()`). |
| `gateEvaluation` | a submitted `Evaluation` exists for the relation. |
| `gateOffer` | an `Offer` in `SENT` or `ACCEPTED` exists for the relation. |

`canTransition()` (`src/lib/stageGate.ts`; the pure half is
`src/lib/stageGateRule.ts`) is asked **before anything is written** by
`PUT /api/mentorship/[id]` (board, candidate page), the bulk advance (per row —
blocked rows come back in `blocked[]`, the rest move) and
`PATCH /api/v1/relationships/[id]/stage` (an API key's `relationships:write`
scope stands in for the capability). A refusal is
`409 { error: 'stage_gate_blocked', gate: { code, stage, missing? } }`.

Never gated: an org on the built-in stages (no rows), a stage with no gate, a
backwards or same-stage move, a move into an off-path stage, and a `COACHING`
relation. `replaceStages()` carries a stage's gates over by key when the caller
does not send them, so an editor that does not know about gates never wipes
them.

**Editing the gates (#1590).** The stage editor shows an "Entry conditions"
row under every on-path stage and saves it through the same atomic `PUT`. Gates
are **not** a paid feature: on the FREE plan the PUT accepts a body that changes
nothing but gates (`onlyGatesChanged()` in `src/lib/stageGateRule.ts`) and
answers `403 plan_required` to any change of key, label, order, colour, phase or
flags. The editor offers `pipeline.transition` (admins with pipeline rights) as
the capability; any other Permission already on a row is kept and shown by name.

**The refusal.** Every UI that moves a stage reads a `409 stage_gate_blocked`
through `stageGateFrom()` and opens `StageGateDialog`
(`src/components/StageGateDialog.tsx`): the stage's label, the reason in the
viewer's language, the missing documents by name, and a link to the documents
section (`#documents` on the candidate page and on the mentor's relation page).
The board puts the card back.
