# 2026-10-29 — Chat apps line: closing note (#1932 and its follow-ups)

What shipped, in order: schema + sealed tokens (#1934) → `chat` router channel (#1939) →
install console, kill switch, real uninstall (#1958) → delivery ledger + retry (#1960) →
Slack/Teams OAuth install + Slack uninstall webhook (#1935) → identity linking (#1937) →
Teams removal via Bot Framework JWT (#3322) → Teams directory via Graph, flagged (#3327).
`docs/chat-apps.md` is the operator's map. Open: the per-category channel matrix (#1707), real
credentials on preview, and the Graph `User.Read.All` consent decision.

Lessons that outlive this line:

- **Check a story's dependencies on `main` before its UI task.** The governance story assumed
  models, an adapter and an install flow that did not exist; building them as their own issues
  first kept every PR reviewable.
- **Never merge by a guessed PR number.** `merge_pull_request` can succeed even with an
  `expectedHeadSha` mismatch; read the PR (`head.ref`, `head.sha`) first and use the number
  `create_pull_request` returned. Never fire the merge in parallel with the create.
- **One protocol stub per vendor** (`slack-mock.mjs`, `botframework-mock.mjs`) with test-only
  env overrides, plus an env-switched no-network client for everything else — and keep the real
  implementation for any method that has its own stub endpoint.
- **`next dev` cold compiles** make the first request to a new route take >15s on a 4-CPU
  container; specs that pass alone can time out back to back. CI runs a production build.
  Give first requests a longer timeout rather than chasing phantom bugs.
- After every `origin/main` merge: `npm ci` (or `prisma generate` + `npm run i18n:scopes`)
  before `tsc`, and `db push` on the local MariaDB — the stale-client errors look like real ones.
