# 2026-10-30 — message push behind the router (#1715)

- **A deferred job payload is a table row.** Passing a message's text through
  `notification.deferred` would have parked it in `Job.payload` until the
  retention sweep. Anything that rides a held delivery should be ids and
  catalogue params only; the preview stays a send-time-only field.
- **`channels: ['push']` keeps a hand-rolled send site honest without moving
  all of it.** The message route still writes its own bell row and its own
  mail; pinning the router to the push channel gave the push a ledger row,
  the matrix, quiet hours and dedupe without widening the PR to #1711.
- **Adding `push` to `defaultChannels` also changes the /account matrix**:
  the grid reads defaults from the catalogue, so a channel that already fired
  but was not declared showed as "off" there.
