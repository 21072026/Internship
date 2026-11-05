# 2026-11-05 — Who-may-receive belongs to the catalogue

- **A role allowlist on the catalogue entry is cheap and fails closed.** `audience` on
  `NotificationEventDef` plus one check in `notifyEvent()`, recorded as `SKIPPED not_audience`,
  stops a wrong id at a call site from putting candidate data in the wrong DM. Read the raw role,
  not the router's `asRole()`, which maps an unknown role to MENTEE.
- **A spec that imports `src/lib/authz.ts` cannot load** (`import 'server-only'`). Drive anything
  behind `requireRoleOrPermission()` over HTTP — the Slack interaction endpoint is a convenient
  door — and assert the app process's work through DB rows (`ChatDelivery` with the stub client,
  `CHAT_APPS_STUB_CLIENT=1`).
- **Pinned `channels` drop the router's chat ride-along.** A caller that pins `['inApp', 'push']`
  to keep its own inline mail gets no chat card; adding chat beside it is a separate
  `channels: ['chat']` send for chat-capable people only, so nobody without chat gets a ledger row.
