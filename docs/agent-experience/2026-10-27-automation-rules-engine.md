# 2026-10-27 — stage automation engine (#1703)

- **The event the issue names may not be the event the catalogue has.** #1703 says
  `pipeline.stage.changed`; the catalogue (and `emitStageChange()`) raises
  `pipeline.stage_change`. Read `src/lib/events/catalog.ts`, not the issue text.
- **A subscriber that pulls a heavy module graph should import it lazily.** The
  registry is loaded by `emit()`, which every producer imports; registering the
  automation evaluator directly would have dragged emailService/notify/goals into
  every producer's module graph (and risked an import cycle through
  `stageChangeEffects → emit`). `subscribers/automation.ts` keeps only the name and
  event list and `await import()`s the body — same trick as `configAudit.ts`'s lazy
  Prisma.
- **Heuristic guards fire on `where` clauses too.** `scripts/test/trial-window-writers`
  flags any file containing a `pipelineStatus` key next to a relation write; a
  guarded `updateMany({ where: { pipelineStatus } })` needs a reasoned `EXEMPT`.
  `check:erasure-coverage` wants a decision for every new `@db.Text` column, and
  `check:i18n`'s MARKETING leak ratchet catches a new "mentee" string in a mail CTA —
  add a MARKETING overlay entry in all three locales.
- **`check:text-limits` was already red on main** (`Company.productPlan`, not from this
  PR) — confirm with `git stash` before chasing it.
- Engine with an injected store (`AutomationStore`) made fire / exclude / fail /
  cross-tenant / redelivery / delay / burst all testable in a `*.unit.spec.ts` in ~1 s.
