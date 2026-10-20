## 2026-10-20: reliability and admin performance (#1436, #2750, #2855, #2322, e2e-full watch)

- **A "flake" that passes locally is often a race that a throttled CPU turns into a certainty.**
  `release-notes-paging.spec.ts:19` (#2750) passed 10/10 against a local production build.
  After `await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 8 })`
  it failed 8/8. Patching `Document.prototype.getElementById` / `Element.prototype.scrollIntoView`
  in an `addInitScript` showed the cause: a `requestAnimationFrame` queued when a fetch resolved
  ran before React committed the appended cards. `getElementById` returned null, and the `?.`
  hid the miss. Do DOM work that depends on new state in an effect keyed on that state, never in
  a rAF or a `.then` after `setState`. Keep the throttle in the spec, so the race is the normal
  case there.
- **Blocking keys are only as good as the biggest bucket.** The #1436 scan had already
  bucketed by e-mail, phone, name and university. An org serving ONE university still put every
  mentee in one `uni:` bucket: 12 s at 5 000 mentees, 46 s at 10 000. A deletion neighbourhood
  (SymSpell: Levenshtein ≤ 2 ⇒ a common string after ≤ 2 deletions per side) blocks the fuzzy
  door losslessly. When you benchmark blocking, generate the skewed population (one bucket
  holding everything), not only the uniform one.
- **Make a long CPU walk a generator, and let the async caller yield on a time budget.** In
  `walkDuplicatePairs()` the sync wrapper drains the generator for the tests. The request path
  `await`s `setImmediate` every ~10 ms. In-process proof: a 20 ms `setInterval` must never stall
  ≥ 100 ms during the walk. End to end: `/api/health` stayed ≤ 73 ms while scans ran.
- **Measure an admin endpoint through the real login with curl, no browser needed.** Fetch
  `GET /api/auth/csrf` with a cookie jar, then
  `POST /api/auth/callback/credentials -d "csrfToken=…&email=…&password=…&json=true"`, then curl
  the endpoint with the same jar. Seed thousands of synthetic MENTEEs with one generated `INSERT`
  (required non-null columns: `id, email, fullName, password, languages, skillLevels, skills,
  updatedAt`), and delete them by id prefix afterwards.
- **Check an issue against `main` before you "fix" it.** #2855 was already fixed at the cause by
  #2862 (plain `<a>` chips, `:visible` locators), and the e2e-full reds of 43de234 by #2991 and
  #2993. Evidence was enough to close: `git log` / `list_commits` with a `path` on the spec, then
  10 repeats on a production build.
- **`gh` works in this container for public-repo Actions logs.** The MCP `get_job_logs` tail is
  all MySQL service teardown. `gh run view <id> -R 21072026/Internship --log-failed | grep -n
  "1) \[chromium\]"` lands on the Playwright error block in one step.
- **`pkill -f "next start"` kills your own shell** when that string is in the bash command line
  (exit 144). Kill by PID: `for p in $(pgrep -f next-server); do readlink /proc/$p/cwd; done`,
  then `kill <pid>`.
- **A required-check-only auto-merge can still merge a PR whose non-required `Lint · Typecheck ·
  Build` is red because of `main`.** When `main` itself is red (here #2999's missing
  notification-catalogue entries), say so once on each PR and tell whoever owns that area. Don't
  patch another stream's design decision.
