# 2026-10-30 — Meeting events in chat (#1942)

- **Router options are the seam, not the adapter.** Anything a channel needs beyond the
  rendered sentence (here: a card subject, a button, supersede intent) goes on
  `NotifyOptions` and must also be copied into the `notification.deferred` job payload —
  otherwise a delivery held by quiet hours loses it silently. Grep `deferDelivery(` when you
  add a field.
- **Adding a method to `ChatPlatformClient` breaks every recording client in the specs**
  (`chat-identity`, `chat-adapter`) at runtime, not at type-check (they are cast). Add the
  no-op there in the same commit.
- **`chat-identity.spec.ts` times out on a cold `next dev`** (first iteration, 60 s
  `waitForResponse`, with harmless `ChatIdentity_workspaceId_userId_key` log noise from the
  propose race it exercises). `--repeat-each=2` passes warm — judge the second iteration.
- `catalog.ts` `defaultChannels` is where a channel is switched on for an event; adding
  `chat` there is safe because the router only adds it for chat-capable (verified) users.
