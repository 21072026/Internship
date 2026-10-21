## 2026-10-20 — survey engine gaps and the health badge (epic #1876: #1877 → #3038, #1904 → #3062)

- **A story whose tasks are all closed can still fail its own acceptance criteria — check them one by one before closing it.**
  #1877's three tasks were closed, yet main had no way to create a survey from an instrument (`POST /api/admin/surveys`
  took only a full question list), the response floor applied per survey but not per question (an optional question
  two people answered returned their numbers and text), and the token spec was not `@smoke`. An Explore agent asked for
  "MET / NOT MET + file:line per criterion" found all three in one pass.
- **A floor applied to the whole survey is not a floor on each question.** Any per-question breakdown of a survey that
  clears its floor needs the same check, or the floor is bypassed by an optional question. `surveyResults.ts` now marks
  such a question `suppressed: true` with only its count.
- **Unit tests under `scripts/test/` that import a `src/lib` file using `@/` aliases need
  `register('./ts-extensionless-resolve.mjs', import.meta.url)` first** (copy the two lines from
  `outcome-destination.test.mjs`). A file that imports Prisma, or uses TS parameter properties
  (`constructor(public code …)`), cannot be imported under `--experimental-strip-types` at all, so test its client-safe half.
- **Playwright 1.64 wants `chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`; the container ships 1194 as `chrome-linux/headless_shell`.**
  A bare directory symlink is not enough because the inner path changed too: make the `-1248/chrome-headless-shell-linux64`
  directory a symlink to `-1194/chrome-linux`, and add a `chrome-headless-shell → headless_shell` link inside it.
- **Do not judge a new client fetch by its timing under `next dev`.** The health badge's request sat in the queue behind
  ~20 panel fetches for 10–20 s and failed a 15 s assertion. Logging `page.on('request')` showed it was issued, and the
  same spec passed 3/3 in 19 s against `npm run build` + `CI=1` (`npm run start`), which is what CI runs. Build once and
  test against prod before "fixing" a slow-dev symptom.
- **Two worktrees can share one `node_modules` through a symlink** (`ln -s ../Internship/node_modules`). The full
  ci.yml Lint-job list (extracted with `grep -E "run: (npm|npx|node|bash) "` and run in a loop) works in both. Run them
  one after another, not in parallel: `build` runs need memory.
- **A branch that is behind main looks "foreign" in a two-dot diff.** The safety check is the three-dot
  `git diff --stat origin/main...HEAD` (what the squash brings). Only that one shows a bot merge that reverts main.
