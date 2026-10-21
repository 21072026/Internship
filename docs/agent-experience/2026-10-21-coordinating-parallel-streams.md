## 2026-10-20/21 — coordinating ~20 parallel backlog sessions (#1575, #2975, #1666, #3040, #3046)

- **A usage-limit stop does not resume by itself.** Around 19:20–21:40 UTC every stream hit the
  account's 5-hour session limit ("You've hit your session limit · resets 10pm (UTC)") and went
  `FAILED`/idle. After the reset nothing woke them: 15 of 19 sessions sat idle for ~1.5 h until the
  coordinator sent each one a "resume" message. A coordinator should keep an hourly check-in
  routine (`create_trigger`, bound to its own session) that lists sessions, and after `resetsAt`
  sends each limit-stopped stream a short resume message. Ask streams to keep their task list
  current, so a resume is cheap.
- **Search open PRs before dispatching an issue.** Two issues handed to new streams already had
  open PRs from an earlier session (#2985 → #2986, #2976 → #2977). Run
  `search_pull_requests` with `repo:… is:pr is:open <N>` plus title keywords first, and tell
  streams to drive an existing PR (merge main in, never rebase someone else's branch) instead of
  writing a second one.
- **Every open PR costs a topic container on the production host and ~15 CI jobs on the shared
  runner quota.** With ~20 streams the queue for a job grew to 5–7 minutes. A cap of "at most 2 open
  PRs per stream" kept both in check. Prod stayed healthy (landing ~1.1 s against a 2 s k6 budget).
- **`next dev` gives each route its own module instance; a production build shares one.**
  Module-level state (`Map`s, timers) that two routes must share has to live on `globalThis`, the
  `src/lib/prisma.ts` pattern. Otherwise a spec is red on every local run and green in CI.
  `src/lib/apiKeyQuota.ts`'s tally was the case (#3040): the admin key list read `requests: 0`
  for a request the `/api/v1` door had just counted.
- **The dev-only API-key guard also refuses platform-level writes.** A rate-limit breach inside
  `runAsApiKeyRequest()`, before the org is bound, lost its `ratelimit.exceeded` ActivityLog row
  locally ("ran in an API-key request with no organisation bound"). A write that belongs to no
  tenant goes through `outsideApiKeyRequest()` (`src/lib/orgContext.ts`). Never wrap a read in it.
- **A date-dependent spec fails one day in seven.** `report-subscriptions.spec.ts` was red only on
  Mondays from 08:00 UTC: the legacy weekly-report seed (`seedLegacyWeeklyReports`) added a second
  subscription that was due then (#2975, fixed in #3026). Pin scheduled passes to a fixed instant
  (`?at=`), choosing one that hits the worst case, and claim one-time migrations a spec does not
  test in `beforeAll`. When Playwright retries in a fresh worker, a second test that depends on the
  first test's setup (an entitlement switched on) fails with a different error, here a 403
  instead of a 400. Make each test set up its own preconditions.
- **The scheduled release compaction can sit for days with no CI.** Its PR (#2973) is opened with
  `GITHUB_TOKEN`, which triggers no workflows, so the required checks never report and the PR never
  merges. `check:release-fragments` warns at >12 pending. Recover by hand per `releases/README.md`:
  `git fetch --unshallow`, then `node scripts/release-compact.mjs` on a branch you push yourself
  (#3046, 39 fragments). A shallow clone also fails `schema-push-safety`'s "#2249 CLI" unit case
  (`test:unit:coverage`) on untouched main. That failure comes from the environment, not the diff.
- **The shared `node_modules` Prisma client goes stale between worktrees.** A `tsc` error naming a
  model or field that exists in the schema (`ApiIdempotencyKey`, `Webhook.apiKeyId`) means the
  client was generated from an older worktree's schema. Run
  `npx prisma generate --schema prisma/schema.prisma` from the newest worktree and run `tsc` again
  before you trust it.
- **A restarted worker loses local daemons.** MySQL was down after the worker restarted (`db push`
  exit 1, Playwright `webServer` timeout). Run `service mysql start` and wait for
  `mysqladmin ping` before anything else.
- **A bot's "Merge origin/main" can revert main.** On #2986 a Copilot-agent merge commit had main
  as a parent while its tree reverted ~100 unrelated files (/api/v1, check-i18n, workflows,
  mobile …). Squashing it would have undone other streams' merged work. Before every push and
  before enabling auto-merge, run `git fetch origin main && git diff --stat origin/main HEAD`
  (two dots, against current main) and confirm it lists only the PR's own files. Do it again
  after any commit you did not write.
