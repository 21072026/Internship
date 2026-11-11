# 2026-10-30 — agreed end date and rhythm per pairing (#1784)

- **Read the model before adding a column the issue names.** #1784 asked for a
  `meetingCadenceDays` column; `MentorshipRelation.expectedMeetingIntervalWeeks`
  (#2014) already existed, with its own panel, route and programme figures.
  A second cadence column would have meant two "agreed rhythms" that disagree.
  Reused the existing one and said so in the PR as an assumption.
- **The issue's "cohort dates" did not exist.** `Cohort` has no dates; the
  settings chain already resolves per programme (`scopes: P`), so the default
  duration/rhythm became two programme-scoped settings instead.
- **Org-less rows and programme settings:** `resolveSetting(key, { orgId: null,
  programId })` does not see a programme row stored under the default org.
  Map a row's org through `settingsOrgOfRow()` first — the in-process e2e found
  this; an API-only test with an org'd seed user would not have.
- **A stale `next start` on :3000** made a fresh run look red
  (`EADDRINUSE` in the start log, old build answering). Check the start log
  before reading the failures; `pkill -f next-server` in its own command, never
  inside an `&&` chain (exit 144 kills the chain).
