## 2026-10-27 — nudge rules engine (#1684)

- **A DB e2e spec can call server modules directly** (`import { evaluateNudgeRule } from
  '@/lib/nudges/evaluate'`) — but not anything that reaches a *lazy* `import('./queueStore')`:
  the Playwright transform does not resolve the `@/` alias inside a dynamic import
  (`Cannot find module '@/lib/prisma'`). Give the function a writer/store parameter and pass
  a capturing one from the spec.
- **`outcomeForStage()` is not "the journey ended"** — it only knows the off-path endings
  the outcome mail speaks for; HIRED/EMPLOYED return null. For "do not message someone whose
  journey is over" combine it with `outcomeStageKeysFrom(stages).finished` and `isTerminal`.
- **`JOB_NAMES` in `src/lib/jobs/types.ts` is a separate list from `JobPayloadMap`** — the type
  checker does not make you add a new job to it; `e2e/job-scheduler.unit.spec.ts` catches it
  only when the job also has a schedule. `webhook.deliver` (#3227) had been missed.
- `npx tsc` after pulling main may need `node scripts/i18n-scopes.mjs` first: the generated
  `src/i18n/scopes.generated.ts` (#3217) is gitignored and written on install/dev/build only.
- Dev without SMTP: `sendEmail()` records `SKIPPED` / `SMTP not configured` in `EmailLog` —
  enough to prove a new mail path reaches the one door with the right category and subject.
