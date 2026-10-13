## 2026-10-08 — interview scheduling (#1844)

- **A meeting is called off through one helper or it haunts a calendar.** The cancel branch of
  `PATCH /api/meetings/[id]` was three inline statements (status flip, late-cancel record, Google
  withdrawal); a second caller would have copied two of them. Extracted to
  `cancelMeetingRows()` first, then both routes call it — the refactor is the feature's first commit.
- **"Create then flip, both in the transaction" is the race guard for a create-plus-status-change.**
  Create the Meeting, run the guarded `updateMany` on the expected status, throw a sentinel on
  zero rows so the transaction rolls the meeting back; the e2e fires two calls in `Promise.all`
  and counts exactly one row.
- **The actor rule was inline in the decision route; a second and third route wanted it.** Move
  it to the lib as a Prisma `where` fragment (`interviewRequestActorWhere`) and have the first
  route read it too, in the same PR — the issue said "extract, do not copy" for a reason.
- **Registering a webhook event is not dispatching it.** `scripts/check-events.mjs` caps direct
  `dispatchWebhook()` callers; a new route registers its names in `WEBHOOK_EVENTS` and says so in
  a comment, like `meeting.cancelled` before it.
- **Notification params are rendered text, so render them per recipient.** The "confirmed time"
  is formatted once per person with their zone and `intlLocaleFor(preferredLanguage)` before it
  is stored — the catalogue test pins the placeholders, the e2e pins the GMT offsets.
