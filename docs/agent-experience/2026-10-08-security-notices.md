## 2026-10-08 — security notification e-mails (#1717)

- **The notification router's e-mail channel sends nothing.** `notifyEvent()` with an
  `email` channel only enqueues a `notification.email` Job and no worker handler consumes it.
  A feature that needs a mail *today* sends it inline through `sendEmail()` and pins the
  router to `channels: ['inApp']` — and says so in a comment, so the day the worker lands
  there is one place to switch. Reading `router.ts` end to end before designing saved a
  silent no-op.
- **A lib module imported from `lib/auth.ts` must not import `emailService` statically.**
  `emailService` imports half the server (`trustedDevice` among it); `auth.ts` now imports
  `securityNotices.ts`. A static edge closes a cycle that works at runtime but breaks the
  repo's one-way-graph rule — a dynamic `await import('@/services/emailService')` inside the
  function keeps the graph acyclic and costs nothing after the first call. The helpers it
  needed (`esc`, `ctaBlock`) were plain functions, not exports: the `__testable` object at the
  top of `emailService.ts` is for tests only, so give a runtime consumer a real `export`.
- **An admin-side disclosure gets no `request`.** The browser and IP on the request are the
  administrator's; quoting them in the owner's mail as "Browser: Chrome on macOS" would be a
  wrong fact, not a missing one. Render the context lines only when the request is the
  owner's own action.
- **Make a rollout of "new device" detection silent by construction.** With "notice only when
  the row was CREATED and the account already had one", every existing account's next sign-in
  writes its baseline and mails nobody; no backfill, no feature flag. Pin that in the pure rule
  (`newDeviceNoticeDue`) and in the e2e (first sign-in → 1 row, 0 mails).
- **The user-agent for an API test comes from `playwright.request.newContext({ userAgent })`**,
  not from a per-request `headers` override — one context per "browser", `signInViaApi()` on
  each, and the baseline/new/repeat sequence is three API calls with no page.
- **Playwright's `Prisma` client in `e2e/helpers/db.ts` sees a new model only after
  `npx prisma generate`** — the spec's `prisma.signInDevice` is a type error until then, which
  the first `tsc` run reports as a missing property rather than a schema problem.
