## 2026-11-06 — closing the hiring backlog: hiring events through the router, talent-pool introductions (#1944 / #3562, #1394 / #3587; closed #1364, #1369, #1372, #1375, #1861)

- **A branch name written in a "taken" comment is not a lock.** I claimed #1944 with
  `feat/1944-hiring-events-chat` in the issue comment. While my session was paused on the
  weekly limit, another session picked the same issue and pushed to *that exact branch*. My
  push was rejected with "fetch first". Never force-push over it. Read the remote branch's
  last commit (`git log -1 --format='%an %s' origin/<branch>`, plus the `Claude-Session`
  trailer), push your own work under a new name, and ask the orchestrator which one goes.
  When you pause for a long time, say so on the issue, or expect the claim to be taken.
- **A WHERE clause without `orgId` relies on a flag that defaults to off.** The tenant
  middleware scopes `User` (and every `TENANT_MODELS` model) only under
  `MT_ENFORCE_ISOLATION=true`, and `.env.example` ships `false`. The talent-pool search had
  no `orgId`, so wherever the flag was off it showed every org's opted-in candidates. A
  two-org e2e fixture caught it in seconds. Put `orgId` into any rule that decides *who is
  visible* (`talentPoolVisibleWhere()` now does), and give every new privacy spec a second
  org.
- **Org-less fixtures hide tenant bugs.** Three talent-pool specs seeded companies and users
  with `orgId: null`, which no real account has after `backfill-organization`. Once the rule
  was scoped, they found nobody. Fix the fixture (create an org, `updateMany` the rows into
  it), never the rule.
- **Moving a send site behind `notifyEvent()` can quietly change channels.** The catalogue's
  `defaultChannels` for `interview_panel.outcome.*` and `interview_request.approved` said
  `['inApp', 'email']`, but the legacy `notify()` calls only ever wrote the bell. Before you
  reroute, compare the catalogue entry with what the old call actually delivered, and make
  the catalogue tell the truth. A pinned `channels:` option also switches chat off: the
  router adds chat only when the call site pins nothing. To keep a hand-built mail, pass it
  as `email:` instead of pinning.
- **Make hiring recipients a catalogue fact (`audience`), not a call-site habit.** The router
  records an outsider as `SKIPPED/audience` on every channel. A unit test that "no internal
  hiring event admits a MENTEE" is cheap and catches the next call-site slip.
- **`check:notify` and other baselines conflict on a single number.** When main has lowered a
  count you also lowered, take main's value and rerun `npm run check:notify -- --shrink`. Don't
  hand-merge the two numbers.
- **Local `next dev` multi-user e2e can time out at sign-in, with no bug behind it.** Specs that
  sign in four users in separate pages stalled on the second or later sign-in: the page
  rendered, but `load` never fired within 20 s. `curl`-warming does not help, because an
  unauthenticated request just redirects. Check the screenshot. If the page is rendered and no
  assertion failed, let CI's production build judge, and say so in the PR.
- **Before writing code for a story, check whether it is already done.** Five of the
  remaining hiring stories had every sub-task closed and their criteria met in code. Closing
  them with a file:line evidence table took minutes; re-implementing would have taken days.
