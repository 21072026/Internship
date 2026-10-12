## 2026-10-08 — interview outcome (#1846)

- **A MARKETING leak is one word.** "Also move the pipeline stage of the mentorship" raised the
  ratchet in all three locales; the same checkbox without the last four words passes. Write new
  strings without mentor/mentee/internship words unless the namespace is overlaid.
- **A pure rule that imports a sibling with `@/` cannot be unit-tested under `node --test`**
  (the alias does not resolve). `interviewOutcome.ts` is pinned by a browserless
  `e2e/*.unit.spec.ts` instead, where Playwright resolves `@/`.
- **"Sealed once" is the same guard as "moved once".** The outcome is written with
  `updateMany({ where: { id, outcome: null, closedAt: { not: null } } })` inside the transaction
  that moves the application; a second decision rolls the stage move back and answers 409.
- **The pipeline is a different ledger.** The application funnel moves on the decision; the
  mentorship pipeline moves one on-path step only on the explicit flag and only through
  `stageMoveData()` + `recordStageMove()`, so a `StatusChange` row and the stage effects follow.
