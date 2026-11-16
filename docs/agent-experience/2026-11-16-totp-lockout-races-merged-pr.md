## 2026-11-16 — TOTP/lockout races, partner media CSP, lead page columns (#3770, #3799, #3732, #3803; #3798, #3800, #3772, #3804, #3809)

- **Adding a `src/pages` directory to fix one route breaks the typecheck app-wide.** Next 15
  then loads the compat navigation types, and `useSearchParams()` / `useParams()` become
  nullable everywhere (57 errors in #3768). Solve the route inside the App Router; for the
  Safari video case the real fix was the route's own CSP, not a Pages Router handler
  (Next strips `Content-Length` from route handlers, and WebKit plays a ranged mp4 from
  `Content-Range` without it).
- **In `next.config.js` `headers()`, the later entry wins for the same key.** A per-route
  `Content-Security-Policy` must come *after* the catch-all `/:path*` entry, or the global one
  overrides it silently.
- **A race through the sign-in form does not reproduce in one process: bcrypt holds the event
  loop.** Concurrent HTTP sign-ins serialize, so the TOTP replay race (#3770) looked fixed when
  it was not. Call the function under test directly from a browserless `*.unit.spec.ts`
  (tagged `@smoke`, costs nothing) with one stale row for every caller —
  `e2e/totp-replay-race.unit.spec.ts`, `e2e/lockout-counter-race.unit.spec.ts`. `origin` there
  is `headerSource({})`, not `new Headers()`.
- **A counter or a "spend once" step is one conditional `updateMany`, never read-add-write.**
  Read-modify-upsert lost concurrent failures and let two callers spend one TOTP step. For the
  first row of a counter use `createMany({ skipDuplicates: true })` and fall back to the
  increment when it returns `count: 0` — a plain `create` that loses the race on the unique key
  logs a Prisma P2002 error on every collision.
- **Before pushing a follow-up commit to an open PR, check it is still open.** #3804 was merged
  while the second commit was being written; the push landed on a merged branch, GitHub showed
  "had recent pushes / Compare & pull request", and the change was not on `main`. Run
  `gh pr view <n> --json state` right before `git push`; if it is merged, cherry-pick onto a
  new branch from `origin/main` and open a new PR.
- **Never edit a release fragment that already shipped — add a new one.** Each fragment is one
  release dated by its merge commit; changing it after the merge rewrites a published version's
  notes. A follow-up PR gets its own `releases/unreleased/<slug>.json`.
- **A "complete" action that hands off to a form must not commit before the form is saved.**
  "Complete follow-up" cleared the follow-up on the click and then opened the interaction form,
  so Cancel lost it. Pass the side effect along (`openInteractionDraft({ …, onLogged })`) and run
  it only after a successful submit; Cancel drops it.
- **`InteractionLog.date` is mixed: date-only from the form (UTC midnight), an instant from
  click-to-call.** A relative label must count calendar days (`relativeDay()`,
  `<RelativeTime granularity="day">`), or a form entry from today reads "9 hours ago".
- **zsh `set -- $pair` does not split on spaces.** Loops that unpack "a b" pairs silently run
  once with the whole string; link sub-issues one call at a time or use bash.
