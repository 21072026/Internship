## 2026-10-27 — per-cohort / per-mentor SLA overrides + deadline backfill (#1640)

- **A unique index over nullable columns is not unique in MySQL.** The issue asked for
  `@@unique([orgId, cohortId, mentorId, stageKey])`; with both ids NULL (the org row) MySQL lets
  two org rows coexist and Prisma cannot address the compound in an `upsert` `where`. A
  `scope String @default("org")` key (written only by `slaScopeKey()`) gives a real unique, and a
  literal default means `db push` fills existing rows — `check:schema-push` stays green.
- **"No mail storm" has two rungs.** Stamping `deadlineReminderSentAt` makes the 09:00 sweep adopt
  a past-due breach silently (`mentorAlreadyTold`), but the escalation ladder would then mail the
  admins at once for every breach whose `dueAt + escalateAfterDays` is long gone. Read
  `checkStageDeadlineReminders()` end to end before trusting a single stamp.
- **Backfills that need new columns go in `prisma/backfills/registry.mjs` (post-push), not the
  pre-push list.** The pre-push steps make the push succeed; anything reading a column the push
  adds must run after it. A fill that a person may later undo by hand should be `once: true`.
- **A pure rule a deploy script needs gets a plain-ESM twin and a test that runs both** (Node 20 on
  the server cannot import TS) — same pattern as `skill-split.mjs`.
- **Playwright here wants `chromium_headless_shell-1248` but the box ships `-1243`.** Symlinking
  the 1243 contents into a `-1248` directory (`ln -sfn …-1243/* …-1248/`) was enough: the SLA specs
  ran green against apt MariaDB + `npx prisma db seed` with the CI env vars from `e2e.yml`.
- **After `git checkout` onto a fresh main, `prisma generate` before `tsc`** — a sibling's schema
  change showed up as dozens of unrelated TS errors until the client was regenerated.
- **A deploy backfill the app also needs: put the core in its own `prisma/*.mjs` module and import
  it from the route** (`'../../../../../prisma/stage-deadline-fill.mjs'`, allowJs; `klaviyoReset.ts`
  is the precedent). The CLI keeps only argv parsing and logging, so deploy and app cannot drift.
- **The container's MariaDB can stop between turns** — `Can't reach database server` in the
  WebServer log means `service mariadb start`, not a code bug.
- **Resolve "which number applies" field by field when rows carry several numbers.** An override
  row that sets days but no escalation must inherit the org's rung, or a cohort's tighter clock
  silently switches the admin escalation off — `resolveSlaEscalations()` vs `resolveSlaDays()`.
