# 2026-10-31 — E2E sign-in race and the slowest smoke tests

- **Read test-history before guessing.** `git show origin/test-history:history.jsonl` holds per-test
  `status`, `retries` and `ms` for the last scheduled runs; join it with
  `npx playwright test --list --grep @smoke` to rank the smoke set by median duration.
- **A PR's red smoke is usually main's.** Compare the failing test names across several PRs'
  `Playwright smoke` logs (`get_job_logs` → the saved file → grep `✘`): the same five on every PR
  meant main, not the PRs.
- **`click().catch(() => {})` on an element that may not exist waits the whole `actionTimeout`
  (15 s).** The consent banner never renders under the seeded `consent.json`, so every "dismiss it
  just in case" cost 15 s. Decide from state (`localStorage.cookie_consent`), then click for real.
- **`clearCookies()` before a second sign-in is a race:** the page being left still polls
  `/api/auth/session` and gets the old session cookie re-issued. Leave for `about:blank` first, drop
  only the session cookie, then open `/auth/signin` — now inside `signInAndSettle` itself.
- **An API-only test does not need UI sign-ins:** `signInViaApi(page.request, …)` shares the page's
  cookie jar and skips the page loads.
