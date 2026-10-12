# 2026-10-07 — Slack Huddle as a BYO meeting link (#2879, PR 1; PR 2 not started)

- **A huddle link needs no new rule.** `checkExternalMeetingLink` already
  accepts `https://app.slack.com/huddle/<T…>/<C…>`; the whole change is the
  label (`meetingProviderName`) plus a pure id-grammar helper. Resist adding a
  provider/room type for it.
- **`/account` resets the personal-room box when `GET /api/profile` answers.**
  A value typed before that lands is wiped and the save button stays disabled
  (`disabled={!profileLoaded || …}`). Wait for
  `expect(getByTestId('timezone-select')).toBeEnabled()` first — the one
  control that is disabled until the profile has loaded (notif-prefs.spec.ts
  uses the same trick with the e-mail group toggles).
- **On this Mac `next dev` is slow enough to eat a 60s test budget on cold
  routes** (`/auth/signin` 21s, `/api/meetings/instant` 10s compile). One
  UI spec that visits two cold routes failed at whichever wait was pending.
  Split such a spec into one test per screen, `test.slow()` with the
  account-access-history reasoning, and warm the routes with `curl` against a
  persistent `npm run dev` (the config reuses an existing server locally).
- **A 401 mid-test can be your own cleanup.** After a test times out, its
  `finally` deletes the user while the page's retried fetch is still in flight;
  the JWT callback treats a missing row as revocation → 401 in the dev log.
  It is a symptom of the earlier timeout, not an auth bug.
- **Local e2e one-liner that works in a worktree (no `.env`):**
  `DATABASE_URL=mysql://e2e:e2epass@127.0.0.1:3306/internship_e2e NEXTAUTH_SECRET=local-e2e-secret NEXTAUTH_URL=http://localhost:3000 npx playwright test <spec>` — without `NEXTAUTH_URL` the first sign-in bounced.
- **`git push` answered `remote rejected … (Internal Server Error)` three times
  in a row** while githubstatus.com said all green and `gh pr create` failed
  with a GraphQL error at the same minute. Not reproducible from here; retry
  later rather than rewriting the branch.
