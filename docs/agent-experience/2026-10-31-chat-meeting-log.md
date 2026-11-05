# 2026-10-31 — Free text in a chat card without a modal

- **A card can take free text without a modal.** Slack accepts an `input` block in a message;
  with `dispatch_action: true` and `trigger_actions_on: ['on_enter_pressed']` its
  `plain_text_input` arrives as an ordinary `block_actions` payload (`type: 'plain_text_input'`,
  the text as `value`). There is no separate button value, so the card's id rides as the
  `block_id`. Teams merges `Input.Text` values into the `Action.Execute` data under the input's
  `id`. Both end up as the envelope's `input`, so no `views.open`, `trigger_id` or task-module
  plumbing is needed.
- **Before adding a "log" action, check what already writes the row.** Every relation meeting
  that happens is auto-logged (`meetingAutoLog.ts`, keyed by the unique `meetingId`), so a second
  "log the session" write would duplicate it. The post-meeting card edits that row instead, and
  the edit route's inline update was extracted (`updateInteraction`, `interactionAccess`) so chat
  and the route share one body.
- **`logEndedMeetingInteractions(meetingId)` is the narrow in-process trigger for e2e.** The sweep
  touches every overdue meeting in the local DB. A `Meeting` row needs `rsvpToken`.
