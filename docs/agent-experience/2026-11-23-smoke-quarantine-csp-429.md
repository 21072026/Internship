# 2026-11-23 — smoke quarantine for the CSP-report 429

- **Symptom → cause:** every PR failed `smoke 2/2` on `e2e/smoke.spec.ts` "admin pages load without
  server errors" with a console `429`. The server log line next to it,
  `ratelimit.exceeded … csp-report`, named the cause: the report-only CSP flooded `/api/csp-report`.
  When a smoke test fails on a console error, grep the WebServer output for `ratelimit.exceeded`
  first. A 429 from the app's own reporting endpoint is not a page regression.
- **Check for an open fix before quarantining:** the real fix (#3643) was open and green for two
  days. A quarantine (#3669) unblocked the other PRs in minutes, but it only buys time. Removing
  the tag is a separate PR once the fix lands. Do it before the expiry date, or
  `check:quarantine` goes red on every PR.
- **Tag syntax:** `{ tag: ['@smoke', '@quarantine'] }` keeps the test in the scheduled
  non-gating quarantine step; the note must sit within 4 lines above the tag.
