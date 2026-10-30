# 2026-10-30 — targeted, scheduled announcements (#1721)

- **A reader rule written for "everyone" breaks quietly once targeting exists.** The feed and
  the image route both said "every broadcast reaches every user". Grep every reader of the
  model (`prisma.announcement`, the image relation) before adding an audience.
- **Schedule a one-off as a job, not a cron**: `enqueue(name, payload, { runAt, idempotencyKey })`
  puts one job at the send time; a cancel only flips the row, and the job's guarded claim
  (SCHEDULED → SENDING) finds nothing.
- **A JSON-null predicate is awkward in Prisma/MySQL**; a boolean twin column (`targeted`) keeps
  the feed filter a plain `OR`.
- **Before calling an e2e failure a regression, run it on main code in the same container**:
  `git stash -u`, let `next dev` recompile, run, `git stash pop`. The two UI-sign-in tests of
  `announcements-feed.spec.ts` (and a third) fail on unchanged main here — the second
  `signInAsFreshUser` lands on the previous user's `/admin` in `next dev`.
