# Meeting attendance and cadence (#2014)

We knew a meeting was scheduled and, if somebody clicked, that it ended. Now
we know who turned up, and can say whether pairs meet on the rhythm they
agreed — the number a programme owner's sponsor asks for.

## The vocabulary — one enum

`AttendanceState`: `ATTENDED` · `NO_SHOW` · `LATE_CANCEL` · `EXCUSED`. It is
**the** attendance vocabulary of the schema: group events (#1856) reuse it on
their own registration row; never declare a second one.

## Recording — `src/lib/meetingAttendance.ts`

`POST /api/meetings/[id]/attendance` (`GET` reads it), for a **pair's**
meeting (a relation meeting, or a standing 1:1 series) and its two people:

- **Two id shapes**, like the end route: a `Meeting` cuid, or
  `<seriesId>:<ISO instant>` for a recurring occurrence with no row. Each has
  its own unique key (`[meetingId, userId]`, `[seriesId, occurrenceAt,
  userId]`), so nothing is recorded twice — a second post corrects the record.
- **The mentor's record wins.** Either participant (or an admin) may record; a
  mentee's record never overwrites one the mentor or an admin made (the reply
  says `kept`). The actor is always stored.
- **`LATE_CANCEL` is derived, never posted** (400): cancelling a meeting
  through `PATCH /api/meetings/[id]` within `lateCancelHours` (setting, default
  24) of its start writes it for whoever cancelled, when they are one of the
  pair.
- **A nudge, not a punishment.** A `NO_SHOW` sends the absent person exactly
  one neutral in-app note (`meeting.noShow`, with a way to reschedule) —
  claimed on the row (`noShowNotifiedAt`), so editing the record never sends a
  second. No score, no badge, no leaderboard.
- **Deleting a meeting keeps its attendance**: `meetingId` is `SetNull` (the
  `PersonalNote` / `InteractionLog` precedent); `relationId` and `meetingAt`
  keep the record attached to the pair and its date.

## The cadence — `src/lib/meetingCadence.ts`

**Deterministic, and called that on purpose** — counted arithmetic over
meetings that happened, against a declared cadence; no model, no weighting, no
prediction (the CTO review: "ship a deterministic health score and call it
deterministic").

- A pair's promised cadence is `MentorshipRelation.expectedMeetingIntervalWeeks`
  (`PUT /api/mentorship/[id]`, admin or the mentor; null = no promise, never
  "off cadence").
- **Met** = not cancelled, started, and nobody recorded `NO_SHOW`. An
  unrecorded meeting counts as attended — recording marks the exception.
- `GET /api/admin/analytics/attendance` and the **Meeting attendance** card on
  `/admin/analytics`: pairs that met in the last 30 days, pairs on their agreed
  rhythm, the no-show rate over 90 days and the median days between meetings —
  each with the count behind it, and **suppressed below five** (the survey
  reporting floor) rather than published over three people.
- Counted: active relations' `Meeting` rows, plus recurring occurrences that
  have no row but do have an attendance record. An occurrence nobody recorded
  and the reminder job never materialized is invisible here.

## Where people see it (#2014, part 2)

- **The end flow.** Ending a pair's meeting from the dashboard banner asks
  "who was there?" (`AttendanceStep`) before the rating card: both people
  default to *was there*, one tap marks a no-show or an excused absence, and
  *Skip* records nothing — which the figures read as everyone came. A
  recurring occurrence gets the step too (it has no row to rate, so no card
  follows); a project room gets neither.
- **The relation record** (`/mentor/mentees/[id]`, `/admin/candidates/[id]`):
  `RelationCadencePanel` shows when the pair last met and whether that is
  inside the agreed rhythm, and lets the mentor or an admin set the rhythm.
  Backed by `GET /api/mentorship/[id]/cadence` — the relation's mentor and an
  admin only, the two who can change the promise.
