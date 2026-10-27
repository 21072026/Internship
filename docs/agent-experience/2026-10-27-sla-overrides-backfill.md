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
