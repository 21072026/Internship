## 2026-10-27 — the tenant leak matrix and its PR gate (#1568)

- **Assert leaks on the raw response text, not on a parsed shape.** `JSON.stringify`-free
  `body.includes(marker)` over per-run stamped markers (ids, addresses, names carrying a random
  stamp) works for every route without knowing its payload, and a nested leak (an `include`d
  relation, a `subjectName`) is caught the same as a top-level one.
- **A leak probe without a negative control is worthless here.** The first run's control caught
  a seed the route never reads (`EvaluationTemplate.scope: 'INTERIM'` — the route only reads
  `EVALUATION_SCOPES` = `MENTEE`/`MENTOR`), which the B→A probe passed silently.
- **Don't `describe.configure({ mode: 'serial' })` a matrix.** One red row skips every later row,
  so the report shows one leak instead of all of them. Without it a failure restarts the worker
  and `beforeAll` re-seeds — slower, but every row reports.
- **One signed-in `BrowserContext` per tenant × actor, cached for the file** (`ctx.request` shares
  its cookies), keeps a 40-test matrix at ~6 sign-ins instead of 40.
- **`@smoke` inside `e2e/isolation/` is unreachable.** The default project `testIgnore`s
  `**/isolation/**`, so the smoke shards never see those tests; the isolation specs need their own
  job (`isolation-gate` in `e2e.yml`).
- **Local Playwright 1.64 wants chromium-1248, the image has 1243:** `ln -sfn chromium-1243
  chromium-1248` (and the `chromium_headless_shell-*` pair) under `/opt/pw-browsers` worked.
