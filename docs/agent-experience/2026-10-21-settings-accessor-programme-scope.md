## 2026-10-21 — Setting programme scope + one accessor (#1619 → #3073, #1621, #3078 → #3079)

- **`check:schema-push` does not catch an FK-backing index drop; test the push against a populated table.**
  Widening `@@unique([orgId, key])` to `(orgId, programId, key)` was green in the guard and in a fresh topic
  DB, but on a table with rows `db push` failed with `Cannot drop index 'Setting_orgId_key_key': needed in a
  foreign key constraint`: MySQL leans on the old unique for the `orgId` FK, and Prisma drops it before it
  creates the replacements. The fix is an expand push (`prisma/push-setting-program-expand.mjs`, same shape as
  `push-company-interest-expand.mjs`), wired into `deploy-prod.sh` + `topic-deploy.sh`. To reproduce: push
  `git show origin/main:prisma/schema.prisma` into a local MySQL 8, insert a few rows, then push the new schema.
- **Expand scripts that hard-code a model block break on the next edit to that model.**
  `push-setting-id-expand.mjs` matches the whole `model Setting { … }` text; any change to `Setting` must update
  that block too, or the script throws on every deploy before its own "already complete" check.
- **Widening a unique over a nullable column silently breaks every `P2002`-as-a-claim.** MySQL treats NULLs as
  distinct, so an org row (`programId NULL`) never collides. `seedLegacyWeeklyReports()` used exactly that as its
  once-per-org claim, and 4 concurrent passes seeded 4×. Grep for `P2002` on the model you re-key. A
  count-then-create in one `Serializable` transaction is a working claim: MySQL makes the count a locking read,
  and the loser gets `P2034`.
- **`settings.ts` is in a client graph; the resolver (`node:async_hooks`) is not allowed there.**
  `retention.ts` → `documentAccess.ts` → a client component, so `npm run build` fails with
  `Reading from "node:async_hooks" is not handled by plugins`. Only the build finds this (tsc does not). That
  reader stays on the legacy `getSetting()` as the one pinned entry in `check:settings-accessor`.
- **Source-text unit tests pin call names.** `scripts/test/ai-never-autosend.test.mjs` asserts
  `getSetting('outcomeAutoSend'`; renaming the reader turns `test:unit:coverage` red. Grep `scripts/test` for
  the old name when you rename a call.
- **Worktrees need `node_modules`.** `ln -s /home/user/Internship/node_modules <worktree>/node_modules` makes
  tsc/build/playwright work there. Playwright 1.64 wants chromium build 1248; the container ships 1194, so
  symlink `chromium-1194` → `chromium-1248` and the headless shell's `chrome-linux` →
  `chromium_headless_shell-1248/chrome-headless-shell-linux64` (plus `headless_shell` →
  `chrome-headless-shell` inside it).
- **DB-only specs run without a server:** `BASE_URL=http://127.0.0.1:9 npx playwright test <spec>` skips the
  webServer. Specs that touch the report sender also need `NEXTAUTH_SECRET` set.
- **Compare against main with three dots:** `git diff --stat origin/main...HEAD`. Two dots also lists
  everything main changed since your branch point.
