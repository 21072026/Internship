# 2026-10-29 — Slack/Teams OAuth install (#1935)

- An e2e guard that greps for a platform URL outside the client folder (chat-adapter.spec) also
  catches a URL *default* in a config module — keep endpoint defaults next to the client that
  calls them (`slackApiBase()` lives in `client/slack.ts`).
- Driving an OAuth install without a browser: request `/connect` with `maxRedirects: 0`, read the
  state out of the `Location`, then call `/callback` yourself with a stub code. Replays across
  users/orgs/platforms are just the same callback from another signed-in request context.
- A webhook with no session (Slack Events) needs a `scripts/route-auth-baseline.json` entry with
  its reason, written by hand — `check:route-auth` fails otherwise.
- Merge only with `expectedHeadSha` and never fire a merge in parallel with the PR-create call:
  a guessed PR number merges someone else's PR.
