# Meeting reminder lead times

Story #1633, task #1636. *When* a meeting reminder fires, per programme and per
meeting — never *whether*: the recipient's `meetingReminders` opt-out is applied by
the sender exactly as before.

## The rule: `src/lib/meetingReminderLeads.ts`

Pure and client-safe; `scripts/test/meeting-reminder-leads.test.mjs` pins it.

Which leads (minutes before the start) apply, first match wins:

1. `Meeting.reminderLeadMinutes` — `0` = no reminder, `N` = one reminder N minutes ahead;
2. the setting `meetingReminderLeadsMinutes` (programme → org → global), e.g. `1440,60`
   (at most 4 values, 1…2880);
3. nothing configured → the leads the product always had: **60** for a one-off meeting,
   **1440 + 60** for a series occurrence.

`dueLead()` decides which lead is due on a tick (every 15 minutes): the smallest lead
whenever the meeting is that close or closer; a larger lead L while the meeting is
within an hour of L and further away than the next smaller lead. With the default leads
that is exactly the old `leadFor()` (the unit test walks every half-minute of the 25-hour
lookahead), and a meeting booked five hours ahead never gets a late "tomorrow".

`reminderDays` (the mentor interaction reminder) was already resolved per relation's
programme by the e-mail sweep and the attention queue alike (#1621).

## One-off meetings

`sendMeetingReminders()` loads every scheduled meeting within the furthest possible lead
and judges each on its own leads. A lead is claimed in `Meeting.remindedLeads`
(`"1440,60"`) by one guarded `updateMany` (the expected previous value in the WHERE); the
smallest lead also stamps `reminderSentAt` — so a meeting reminded before the deploy
(stamp set, no list) is never reminded again. Moving a meeting clears both. The queued
mail's dedupe key carries the lead, except for 60, whose key is unchanged.

## Series

`MeetingSeriesReminder` gained `leadMinutes Int?` and its `lead` enum became nullable —
**not re-typed in place** (an enum → Int change under `db push --accept-data-loss` drops
the column). Each claim writes both: `leadMinutes`, and the enum for 1440/60. Both unique
keys guard it, so a pre-deploy row (`lead` only) still collides with a new claim for the
same lead. A lead from half a day out reads "tomorrow", closer in "soon".

## Where to set it

- `/admin/settings` → "Meeting reminders (minutes before)", with the inheritance badge
  (`SettingProvenance`). A programme layer is written through the settings API.
- The meeting form: "Reminder" — programme default / 1 day / 1 hour / 30 minutes / none.
  `POST /api/meetings` and `PATCH /api/meetings/[id]` accept `reminderLeadMinutes`.
