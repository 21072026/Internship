## 2026-10-20 — charting layer, forecast panel, meeting change notices (#1890 #3044, #1897 #3067, #1982 #3085)

- **Measure a chart library before you pick it, with esbuild over exactly the parts you will use.**
  `esbuild entry.js --bundle --minify --format=esm --external:react --external:react-dom` with
  an entry that re-exports only those parts gave visx 4 at 19.5 KB gzip against recharts 3 at
  120 KB (recharts ships redux toolkit and immer). The route's First Load JS from `next build`
  is the before/after number a PR states. A `next/dynamic` chunk does not count toward it, so
  report the chunk's own size next to it.
- **The local npm (10.9) rewrites `package-lock.json` and drops every `"libc"` field.** Install
  new dependencies with `npx -y npm@11 i …`, and check that `git diff package-lock.json | grep '^-'`
  removes nothing. Otherwise the lockfile diff is hundreds of lines of unrelated churn.
- **SVG charts get their colours from CSS tokens, never from Tailwind classes.** `fill="var(--chart-1)"`
  works as a presentation attribute in Chromium. `--chart-*` lives in `globals.css` with an
  `html.dark` override, and `--chart-1` sits on the accent ramp. A chart rect cannot see
  `html.dark .bg-blue-500`.
- **Put `data-label` and `data-value` on every chart mark.** A spec can then assert "pixels are
  this value's share of the plot" instead of reading CSS percentages. That turned #1501's
  reproduction (resize + client-side navigation) into a three-line helper in
  `e2e/analytics-trends.spec.ts`.
- **A conversion rate over journeys that are still open is censored.** If a journey still sits
  in stage k, `stageConversions()` counts it as "did not advance" there. A projection
  multiplies that error through every later stage. `resolvedConversions()` in
  `src/lib/forecast.ts` counts an open journey only for the stages it has left. Use it wherever
  a rate is carried forward.
- **`check:i18n` counts every string that mentions mentors toward the MARKETING leak ratchet.**
  This holds even for a panel that MARKETING never renders. Put those strings in their own
  top-level namespace and give it an argued `LEAK_EXEMPT` entry naming the server-side gate
  (here `capacity: null` without `mentorship`). Don't raise the count.
- **A new nullable FK column also needs a `textLimitsRegistry` entry.** `check:text-limits` fails on
  `MeetingRequest.counterOfMeetingId` until it is registered as `ID`. Run the whole Lint-job
  list, regenerated from the current `ci.yml`. `main` added `check:hardcoded-strings` during
  this session.
- **Don't "fix" a local DB that drifted across branches; recreate it.** After switching between
  worktrees on different schemas, `prisma db push` failed on a `DropIndex` step, and seven
  unrelated specs went red. `DROP DATABASE internship_test; CREATE DATABASE internship_test;`
  then `db push` and `db seed` brought it back in a minute. Check `push $?` before trusting
  an e2e run.
- **A symlinked `node_modules` cannot survive a dependency change on `main`.** Once a merge
  touches `package.json`, `unlink node_modules` and run `npm ci` in the worktree itself.
  `npx prisma generate` after every merge that touches the schema; a stale client shows up as
  tsc errors in files you never opened.
- **After a container restart, `service mysql start` comes before anything else.** Playwright's
  "Timed out waiting 120000ms from config.webServer" was MySQL being down, not the app.
