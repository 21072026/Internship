# 2026-10-29 — Chat install console (#1958)

- A UI click whose effect you assert later is easier to debug when the spec waits for the
  request it should cause (`page.waitForResponse(...)` around the click) and asserts its status:
  a missing request, a 403 and a slow first compile under `next dev` then fail differently.
- A platform client that tests must not reach from the server process gets an env-switched
  no-network stand-in (`CHAT_APPS_STUB_CLIENT=1` in `playwright.config.ts`'s webServer env), the
  same pattern as `AUDIT_DRAIN_ALLOW_INSECURE_RECEIVERS` — never set on a deployment.
- When a ledger must outlive the parent it points at, make the FK nullable with `SetNull` and put
  the ledger in the retention registry in the same PR; a cascade quietly deletes the history.
