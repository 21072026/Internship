# 2026-10-30 — Booking from chat (#1951)

- **"Indistinguishable from the app" can hide a product decision.** The issue said a chat pick
  writes a Meeting; the app lets a mentee only *request* one. Check what the in-app path allows
  for the clicking role before building — and ask (here: the orchestrator decided "request, mentor
  confirms") instead of quietly adding a right.
- **Extracting a route body verbatim into `lib/` as `fn(session, input): Promise<NextResponse>`**
  is the low-risk way to get one write path for a second caller: the route becomes a 5-line
  wrapper, every check keeps its exact wording and status, and the existing route specs
  (`meeting-requests`, `double-booking`, `booking-guardrails`, `scheduling-assistant`, …) pin it.
- **Identical Slack bodies within 5 minutes are replays** under the #1948 endpoint: an e2e that
  clicks the same button twice in one second must vary the payload (`action_ts`), like Slack does.
- **`notify()` vs `notifyEvent()`**: switching a bell to the router changes its deep link (the
  catalogue's `link` kind). To add only a chat card next to an existing bell, call `notifyEvent`
  with `channels: ['chat']` for `chatCapableUsers()` — no SKIPPED ledger noise for everyone else.
