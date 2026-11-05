# 2026-11-05: Chat commands and a generated manifest

- **A Playwright spec cannot import a `.mjs` that uses `import.meta`.** Playwright transpiles it as
  CommonJS and fails with "Cannot use 'import.meta' outside a module". Test a plain ESM script by
  running it with `execFileSync('node', ['scripts/x.mjs', …])` and reading what it writes, which
  is also how CI and a deployment run it.
- **A browserless `*.unit.spec.ts` cannot import the chat interaction registry.** `actions.ts`
  pulls in `src/lib/authz.ts`, which imports `server-only`. To assert that a handler exists, read
  the source text (`registerChatAction('command.x'`) instead of importing the registry.
- **One JSON, three readers.** `src/lib/chat/chatApp.json` is read by the dispatcher (TS,
  `resolveJsonModule`), the Slack install's scopes (`config.ts`) and the plain-Node manifest
  generator. A Node 20 script cannot import TS, so the shared data lives in JSON rather than in
  a `.ts` constant mirrored by hand.
- **A Teams message activity gets no reply in its HTTP response.** Answer after the 200 by posting
  to the activity's own `serviceUrl` + `conversation.id`. The Teams client re-checks that host
  against Microsoft's before it posts.
