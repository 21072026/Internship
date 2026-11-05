## 2026-11-05 — coaching relations and hire attribution in the UI (#1507)

- **Find every caller of a stage move before adding a question to it.** Besides the stage
  select, `OfferManagementPanel` moved the candidate to the hire stage through `changeStage`
  directly; routing it through `requestStageChange` is what makes the attribution question
  cover the offer path too.
- **A Prisma `select` hides new columns from server components.** The portal page selected its
  relation fields by hand, so `relation.kind` was a type error until `kind: true` was added;
  routes using `include` got it for free.
- **Test a new dialog in front of an existing refusal.** Answering the attribution dialog and
  then hitting the stage gate must close the first and open the gate dialog with nothing
  written — a single spec covers cancel, gate-refused and gate-lifted on the same relation.
- **Stage gates in a spec go through the editor API** (`PUT /api/admin/organizations/<id>/pipeline-stages`
  with `gateDocuments`), not a hand-inserted `PipelineStage` row, which would turn a default
  catalogue into a one-stage custom one.
