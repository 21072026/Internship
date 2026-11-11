## 2026-10-29 — main red: ci.yml + e2e-full after a 75-PR night

- **By the time you've diagnosed main, main has moved — and someone may have fixed it.** The
  `check:erasure-coverage` break I opened a PR for was fixed by two other sessions within the
  hour (they even left `RequisitionFit.reason` twice in the coverage `Map`). `git fetch` and
  re-run the failing check on fresh `origin/main` *before* pushing a fix; close yours as
  superseded rather than racing it in.
- **Fresh main also brings fresh breaks: rerun every `ci.yml` step after each rebase.** Between
  two fetches main gained a lint error (`require()` in `src/lib/cspPolicy.cjs`) and an un-recorded
  webhook contract (`offer.*@1`, `UPDATE_WEBHOOK_CONTRACT=1` — check the fixture diff is
  additions only). A loop over `grep -oE "run: npm run [a-z0-9:-]+" .github/workflows/ci.yml`
  runs them all in a couple of minutes.
- **After a pull, run `npx prisma generate` AND `node scripts/i18n-scopes.mjs`.** A stale
  client gives dozens of TS2339s; a stale (gitignored) `scopes.generated.ts` rejects every new
  `<I18nScope scope="…">` with TS2322.
- **The e2e-full failure text is in the `e2e-json-shard-N` artifacts, not the job log tail.**
  `get_job_logs` tails only cleanup; `download_workflow_run_artifact` + a 10-line walker over
  `suites[].specs[].tests[]` (status `unexpected`) lists every failing spec with its message.
- **`mobile-layout-coverage` goes red for every new admin sidebar link.** Five new screens
  (`availability`, `events`, `nudges`, `automations`, plus `operations` audited elsewhere) hit it
  this time. Add the route to a sweep list in the same PR that adds the nav link.
- **`signInAsFreshUser(page, …, '/portal')` for a MARKETING mentee is a race, not a check.**
  `/portal` bounces it to `/account` (#2351); `waitForURL` passes only when it catches the URL
  mid-bounce — green locally, red on CI. Wait for the final landing.
- **Swagger UI's `filter` re-renders tags closed after a delay**, so a click on a tag right after
  `fill()` can be undone. Click-until-open inside `expect(...).toPass()`.
- **A native `<input type="file">` is ~300px wide** and spills a phone-width card; give it `w-full`.
- **Playwright 1.64 wants `chromium_headless_shell-1248`; the container has 1243.**
  `ln -sfn /opt/pw-browsers/chromium_headless_shell-1243 /opt/pw-browsers/chromium_headless_shell-1248`
  worked; *.unit specs run without the app via `BASE_URL=http://localhost:9`.
