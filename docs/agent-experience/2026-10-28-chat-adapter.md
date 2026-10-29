# 2026-10-28 — Chat channel on the notification router (#1939)

- The issue described a `ChannelAdapter` registry and a per-category channel matrix (#1706/#1707)
  that the tree does not have: `router.ts` dispatches `inApp`/`email` with plain `if` blocks. Add
  the new channel the way the file already works (one branch, one adapter module) rather than
  inventing the registry inside a feature PR.
- Platform clients that tests must replace: an in-process test seam (`setChatClientsForTests`)
  plus a DB spec that calls `notifyEvent()` directly from the Playwright process is far simpler
  than a stub HTTP server, because the server's webServer process is not where the code runs.
- A URL that arrives as stored data from a platform (Teams `serviceUrl`) still needs a host
  allowlist before `fetch` — data is not configuration.
