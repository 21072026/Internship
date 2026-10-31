# 2026-10-31 — Answering on the chat card (#1949)

- **`requireRoleOrPermission()` reads the cookie session itself.** A shared service called from
  the chat dispatcher (no request cookie) needs the caller's session passed in — it now takes an
  optional `opts.session`; the actor is still read live from the database, so nothing is trusted
  from the synthesized session beyond its user id.
- **Make the shared write idempotent rather than the handler.** `recordMeetingRsvp()` guards the
  `updateMany` on `rsvp: { not: status }` and notifies only when a row changed: the web page and
  the card both get "click twice = write once" for free.
- **Exact-shape unit asserts break on additive fields.** `chat-card.unit.spec.ts` compared the
  whole `ChatCard` with `toEqual`; adding `buttons` reddened it. Assert the new field explicitly
  per card kind instead of loosening to `toMatchObject` — it pins which cards carry buttons.
- **Run e2e against a production build locally** (`NODE_OPTIONS=--max-old-space-size=7168 npm run
  build`, then `CI=1 npx playwright test …`): `next dev` cold-compiles each route on first hit and
  times out sign-in-heavy specs; the prod server ran 55 specs in 2 minutes with no flake.
