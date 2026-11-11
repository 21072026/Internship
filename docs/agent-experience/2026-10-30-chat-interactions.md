# 2026-10-30 — One verified chat interaction endpoint (#1948)

- **The chat verifiers already existed** — `src/lib/chat/slackSignature.ts` (uninstall
  webhook) and `src/lib/chat/botFrameworkAuth.ts` (Teams messages, #3322) — and the e2e
  config already runs a Bot Framework JWKS stub with a `/__sign` endpoint. Grep `src/lib/chat/`
  before writing any crypto for a chat surface.
- **A dev-server spec cannot register a test-only handler**: the registry lives in the server
  process. Ship one real, harmless built-in action (here read-only `meetings.upcoming`) so the
  HTTP-level @smoke spec exercises the whole path.
- **A Slack reply needs an outbound sink**: start a loopback `http.createServer` inside the
  spec and gate loopback `response_url`s behind an explicit e2e switch in
  `playwright.config.ts`, the same pattern as `AUDIT_DRAIN_ALLOW_INSECURE_RECEIVERS`.
- **"InternCRM" counts as a MARKETING leak** in `check:i18n` (it contains "intern"): keep the
  product name out of server-side copy that MARKETING can render.
- **`git stash -u` is the safe way to park WIP across a branch switch** when a CI fix on
  another PR interrupts — `git stash pop` onto a fresh branch from `origin/main`.
