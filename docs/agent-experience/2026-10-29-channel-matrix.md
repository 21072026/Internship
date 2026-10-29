# 2026-10-29 — channel matrix and quiet hours (#1714)

- **Never guess a PR number.** I issued `merge_pull_request` on a number I
  expected `create_pull_request` to return, in the same parallel batch. The guess
  was another session's PR (already merged, so no harm). Create first, read the
  number from the result, then merge with `expectedHeadSha`.
- **Check the branch base after a context break.** My working branch had been
  cut before my own previous PR (#3316) merged; the router conflict only showed up
  on `git stash && git reset --hard origin/main && git stash pop`. Run
  `git log HEAD..origin/main` before building on an old branch.
- **`PUT /api/profile` replaces `notificationPrefs` wholesale and its schema is
  `record<string, boolean>`**, while the account page PUTs back the blob it read.
  Any new non-boolean key in that JSON must be stripped from the body (zod
  `preprocess`) and carried over from the stored row, or the first switch click
  either 400s or wipes it.
- **A python `str.replace` anchor that does not match is a silent no-op**, and a
  common anchor (`{ timeoutMs: 60_000 });`) matches the *first* occurrence, not
  the one you meant. Assert the anchor is present and unique, and grep the
  result.
- A preference that removes a channel should still leave a ledger row
  (`SKIPPED channel_off`) — filtering it out before the claim made the opt-out
  invisible to the person asking why a mail never came.
- **A controlled checkbox that waits for the server breaks Playwright's
  `check()`/`uncheck()`** ("Clicking the checkbox did not change its state"):
  update state optimistically and roll back on failure, like the other switch
  lists on /account.
- **`next dev` in this container collapses under a whole UI spec file**
  (timeouts on first compile, then `ERR_CONNECTION_REFUSED` mid-run). For a
  UI spec, `npm run build` once and run with `CI=1` so Playwright uses
  `next start` — the failures that remain are then the real ones.
