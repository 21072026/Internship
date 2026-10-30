# 2026-10-30 — SOURCE outcome panel (#1914)

- **Claim before you start, and check for a twin.** `search_pull_requests` with the issue
  number plus an "üstlendi" comment on the issue is cheap and keeps two sessions off one task.
- **A pure rule file with zero imports is the fastest thing to unit-test** here:
  `node --test --experimental-strip-types` loads it directly; an `@/` import would not resolve.
- **Censoring is the trap in any "time to X" number**: keep unplaced rows out of the median and
  return the population (`placed`, `considered`) so the screen can say what it measured.
- **`npm run build` OOMs at the default heap in this container** — run it with
  `NODE_OPTIONS=--max-old-space-size=8192`, then `npm run start` + `BASE_URL` for Playwright.
- A SOURCE e2e is easiest with its **own organisation**: seeded users otherwise have a NULL
  `orgId`, and a route that filters on the session's org then reads the null-org rows.
