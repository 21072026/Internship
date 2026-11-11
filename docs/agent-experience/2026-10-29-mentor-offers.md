# 2026-10-29 — Mentor Offers (#1809)

- **An issue's dependencies may still be unbuilt even when the issue cites line numbers for
  them.** #1809 asks to write a `MatchDecision` (#1789) and to sweep "next to #1775's request
  expiry"; neither exists on main. Grep the schema before designing around a model.
- **A new notification type needs three things, not one:** the `notifications.events` strings
  (EN/TR/DE), a MARKETING overlay for each when the words say mentor/mentee (the leak ratchet),
  and an entry in `src/lib/notifications/catalog.ts` — `scripts/test/notification-catalog.test.mjs`
  fails otherwise. A new mail category needs a group in `emailGroups.ts` and an
  `OUTBOUND_CATEGORIES` entry.
- **A new scheduled job** is a `JobName` in `src/lib/jobs/types.ts` (type map + `JOB_NAMES`), a
  `queue({...})` in `schedules.ts` and a `registerJob()` in `src/jobs/` —
  `e2e/job-scheduler.unit.spec.ts` checks all three line up.
- **Reusing a decision service from a different actor:** create the request it expects and call
  it, then undo the request on a non-200. It keeps one write path for relations instead of a
  second copy of the plan gate and the #419 guard.
- A new MENTOR nav key needs an icon in `apps/mobile/src/lib/menu.ts`.
