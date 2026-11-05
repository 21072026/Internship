# 2026-11-05 — A new channel for a capped message

- **A cap stays a cap only if the channel is chosen after the claim.** The dormant check-in
  claims `dormantNudgeCount` first, then asks chat, and mails only when the card did not go. One
  claim, one message on one channel. Adding chat as a second send next to the mail would have
  doubled the cap silently, and a chat-specific counter would have split it.
- **Treat a quiet-hours hold as delivered.** `notifyEvent()` answers `queued` for a card held for
  the person's quiet hours; it will go once. Counting only `sent` would mail the person too.
- **`await import('@/…')` does not resolve under Playwright.** The `@/` alias works for static
  imports in specs, but a dynamic import inside `src/` that a spec reaches fails with "Cannot find
  module '@/lib/…'". Use a static import; `emailService.ts` already imports the router, so
  importing a chat helper adds no new cycle.
- **Check a closed PR's leftovers before reusing an idea.** The catalogue `audience` field lived
  only in a PR closed as duplicate (#3561). It is not on main, and the tsc errors were the
  reminder.
