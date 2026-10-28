# 2026-10-28 — Core Web Vitals budget (#1593)

- **The PR gate serves `npm run start`** (`playwright.config.ts`: `process.env.CI ? 'npm run start' : 'npm run dev'`),
  so a perf budget in an e2e spec measures a real production build in CI. Locally it is only
  meaningful after `npm run build` + `PERF_BUDGET=1` against `npm run start`; the spec skips otherwise.
- **First-load JS bytes are the stable budget**: `encodedBodySize` of script resources is
  deterministic per build, LCP on an unthrottled runner is not. Budget LCP generously.
- To measure a page's *first* load after signing in, open a second browser context with the
  first one's `storageState` and its `baseURL` — a `browser.newContext()` does not inherit the
  project's `baseURL`, and the sign-in page has already warmed the shared chunks in the first one.
- `check:route-auth` was red on main (a new public route without its baseline entry). Any
  sibling's PR inherits that; porting the one baseline entry is cheaper than waiting.
- `scripts/route-auth-baseline.json` must be edited as text: a `json.dumps` round trip
  reformats its hand-wrapped arrays into a 200-line diff.
