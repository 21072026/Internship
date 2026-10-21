# Channel matrix, quiet hours and blackout days (#1714)

Who gets what, **where** and **when**. The rule is pure in
`src/lib/notificationScheduleRule.ts` (unit-tested,
`scripts/test/notification-schedule.test.mjs`); it is enforced in exactly one
place, the router (`src/lib/notifications/router.ts`).

## The channel matrix

Stored inside `User.notificationPrefs`, next to the boolean switches:

```jsonc
{ "deadlines": true,                                  // category switch (unchanged)
  "channels": { "deadlines": { "email": false } },   // sparse overrides
  "quietHours": { "start": "21:00", "end": "08:00" } }
```

- **Sparse.** An absent entry means the catalogue's `defaultChannels`, so an
  account with no `channels` key behaves exactly as before, and nobody who opted
  out through a legacy e-mail-group key is re-subscribed.
- **The category switch outranks it.** A category that is off is off on every
  channel; the matrix only turns a channel off inside a category that is on.
- **Enforced in the router**: `channelAllowed()` there returns `channel_off`
  (a `NotificationDelivery` row with that `skipReason`) for both the in-app and
  the e-mail channel. Essential (`account_security`) events ignore it.
- **Written** through `PUT /api/profile` with `notificationChannels` (the whole
  matrix, sanitised to known categories × channels × booleans) and
  `quietHours` (`{ start, end }` as `HH:MM`, or `null` to clear). A PUT of
  `notificationPrefs` keeps only its booleans and carries both over, so the
  existing switch saves cannot wipe them.
- **UI**: the "Where each kind of notification reaches you" table and the quiet
  hours row on `/account` (`data-testid="channel-<category>-<channel>"`,
  `quiet-hours-*`). A table, not `<label>`s, so the category names are not
  rendered twice as labels (`e2e/notif-prefs.spec.ts` finds the switches by
  label text).

## Quiet hours and blackout days

- **Quiet hours** are per user, read on the recipient's own clock
  (`User.timezone`, else the deployment zone). A window may wrap midnight.
- **Blackout days** are per org: the settings `notificationBlackoutDates`
  (comma-separated `YYYY-MM-DD`, normalised on save, at most 366) and
  `notificationBlackoutWeekends`, edited under Admin → Settings.
- They **reschedule, never drop**: the e-mail job is created once, now, with
  `runAt` = `nextOpenInstant()` — the window's end, or 00:00 of the next open
  day. A repeat of the same send is deduplicated as before, so a delivery due at
  02:00 inside a 21:00–08:00 window arrives at 08:00, once.
- They hold back the **interrupting** channels only (e-mail today; push with
  #1715). The in-app bell is never delayed — it waits for the next visit anyway.
- `account_security` never waits. A calendar closed for more than ~13 months is
  ignored rather than holding a notification forever; a settings read that fails
  sends now.

Not covered here: the scheduled digests and reminder crons that call
`sendEmail()` directly rather than the router. They move under these rules when
they move onto the router.
