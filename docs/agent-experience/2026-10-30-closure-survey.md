# 2026-10-30 — closure plan, close-loop survey, closure report (#1795)

- **An issue's "there is no X" goes stale.** #1795 (written 2026-08) said
  "there is no survey engine — keep this a fixed form" and specified its own
  `RelationClosureSurvey` model. By now the engine existed (#1879–#1912:
  templates, campaigns, signed links, a reminder cap, CONFIDENTIAL mode). I had
  already written the model before grepping `src/lib/survey*`; grep for the
  concept (survey, nudge, reminder) before modelling it, not after.
- **A template has a hard cap** (`SURVEY_TEMPLATE_MAX_QUESTIONS`, three plus
  the NPS item). The issue's four questions became three plus NPS, with NPS as
  "would you recommend".
- **Engine bug found by the second pairing.** `DAYS_AFTER_END` keyed its period
  `after:<n>` and the invitation `round` was `''` — a mentor who ended two
  pairings got one invitation. Per-relation period + round, and a
  `legacyPeriodKey` check so the key change re-invites nobody already sent.
- **MariaDB stops when the session's worker restarts.** A
  `PrismaClientInitializationError` on the first query means `service mariadb
  start`, then restart `next start` too (it cached the failed pool).
