## 2026-11-15 — grouped admin sidebar with hub pages (#3752, #3757)

- **Generate the local gate from `ci.yml`, never from a hand-picked list.** A grepped subset is
  how #3632 shipped a red `check:locale-list`. Parse `.github/workflows/ci.yml` with
  `node_modules/js-yaml`, emit every `run:` step into one bash script that logs each step to its
  own file and collects failures, and regenerate it after every `origin/main` merge, because
  steps get added. That is 75 steps today, including `npm run build`, so the e2e runs that
  follow can use `CI=1` (`next start`) on that build.
- **Run e2e against the prod build, not `next dev`.** On the dev server the first visit to each
  route compiles it and specs time out. After `npm run build`, `CI=1 npx playwright test …`
  starts `next start`, and a ~800-test `@smoke` run takes ~12 minutes in the container.
- **In a dirty local DB, `demo-fidelity`'s `prisma db seed` / `seed:demo` fail on duplicate
  keys** (`Source_orgId_name_key`). That is local state, not the change. GitHub CI runs them on
  a fresh database. Name them as such in the report rather than leaving them out.
- **`main` moves during a 35-minute gate.** Twice, two new commits landed while the full gate
  ran. Before merging, list the files both sides touched
  (`comm -12 <(git diff --name-only HEAD...origin/main|sort) <(git diff --name-only origin/main...HEAD|sort)`).
  If only a shared dictionary overlaps, merge the new commits and run a targeted gate: tsc,
  lint, the i18n checks, unit tests, build, and the affected and new specs. Say plainly that
  this differs from a full gate, and wait for GitHub CI to go green on that exact head before
  merging with its `sha`.
- **Reshaping the nav: prove reachability with a unit test, not by clicking.** A link tagged
  into a group or a hub can silently vanish for one audience. `scripts/test/nav-groups.test.mjs`
  runs `visibleNavLinks()` → `groupNavLinks()` for each vertical × {plain, operator,
  super admin} × every `ADMIN_TIERS` permission set. It asserts that every visible link lands
  in the top list, a group's sidebar or its hub, and that no group comes out empty.
- **The admin tour pins sidebar links.** `guidance-tour` targets `data-tour-id="nav-board|
  nav-candidates|nav-users|nav-settings"`, and the tour skips a missing target, so the spec's
  step count breaks. Those four must stay sidebar rows (not hub rows), and collapsible groups
  must default to **open**: collapse is what gets persisted, and the active page's group is
  forced open.
- **A new i18n namespace that only internship links read still counts as a MARKETING leak.**
  `check:i18n` counted the hub descriptions of mentorship-only pages. The fix was a
  `LEAK_EXEMPT` entry whose reason is backed by a unit test. The test pins that every key of
  that namespace belongs to a `mentorship`/`projects`-gated hub link, so the exemption cannot
  silently cover a shared string later.
- **A new `src/app/admin/<section>` needs its `layout.tsx` with `<I18nScope
  scope="admin/<section>">`**, and the `scope` type only knows it after
  `node scripts/i18n-scopes.mjs` regenerates the gitignored `scopes.generated.ts`. Otherwise tsc
  reports "not assignable to type" for the new scope.
- **After merging `origin/main`, run `npx prisma generate` before tsc.** A stale client shows up
  as type errors on fields another PR just added, which look like your bug but aren't.
- **When the GitHub MCP tools fail, `gh api` REST still works** for opening a PR
  (`POST …/pulls -F body=@file`), editing its body (`PATCH`), reading check runs
  (`commits/<sha>/check-runs`) and merging (`PUT …/pulls/<n>/merge -f sha=<head>`).
