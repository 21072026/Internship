# Double-booking guard (#1995)

Nobody gets double-booked. Every write path that puts a meeting on a calendar
refuses an hour one of its participants already has. The refusal happens on the
server, so it is a rule, not a hint in the UI.

## What "busy" means

A person is busy for:

- a **`Meeting` row** of a relation they are the mentor or the mentee of, or of a
  project they are a member of. A cancelled meeting does not count. A meeting
  someone ended early (`endedAt`) counts only until it ended.
- every **occurrence of an active `MeetingSeries`** of their relation or project.
  Recurring meetings are not stored as rows, so they are expanded from the rule
  (`ruleOccurrences`). A checker that read only `Meeting` would miss every weekly
  call.

The length comes from `meetingDurationMinutes()` (#1984). It is never a
hard-coded 60.

Busy means **taking part, not creating**. An admin who schedules one session for
twenty pairs is the organiser of twenty rows and the participant of none. Their
own bookings therefore never collide with each other. The issue text said
"mentor, mentee or creator". The creator was left out deliberately: counting it
would make every bulk-scheduling admin collide with themselves.

## The two layers

| File | What | Tested by |
|------|------|-----------|
| `src/lib/busyWindowsRule.ts` | `overlaps`, `mergeWindows`, `firstConflict`, `filterBookedOccurrences`: pure, client-safe | `scripts/test/busy-windows.test.mjs` |
| `src/lib/busyWindows.ts` | `busyWindows` (reads the rows), `findConflict(For)`, `bookWithoutConflict`, `recordForcedBooking`: server-only | `e2e/double-booking.spec.ts` |

Intervals are **half-open**: `[09:00, 10:00)` and `[10:00, 11:00)` are back to
back, not a clash. This is the same convention `/api/availability` uses for
slots. The instants are absolute, so a DST change cannot make two meetings
overlap.

## Where it is enforced

| Path | Behaviour |
|------|-----------|
| `POST /api/meetings` | Checked **per relation**. A bulk schedule books the free pairs and lists the rest in `conflicts`. Only if nothing could be booked is the answer a 409. Rows of the same batch (`batchKey`) do not collide with each other: one session is one room. |
| `PATCH /api/meetings/[id]` | Checked when the time **or the length** changes. The rows being moved, and the rest of their session, are excluded, so a meeting does not collide with its own old slot. |
| `POST /api/meeting-requests` | The proposed hour is checked for both people. |
| `PATCH /api/meeting-requests/[id]` (accept) | Checked again, under the lock. The hour may have been taken since it was asked for. On a conflict the request stays `PENDING`. |
| `GET /api/availability?mentorId=` | Returns `busy` (merged, bare `start`/`end`) to an admin or the paired mentee. The portal's slot picker drops occurrences that overlap them. `expandSlots()` stays database-free. |

The refusal shape is always the same:

```json
{ "error": "…", "code": "conflict", "conflictsWith": { "title": "Kickoff", "startsAt": "2026-10-26T09:00:00.000Z" } }
```

**The title is withheld** (`""`) when the caller takes no part in the meeting
that is in the way and is not an admin. For example, a mentee asking for their
mentor's Tuesday learns that it is taken, not what another mentee booked it for.
The UI then says "already taken" instead of naming it. The `busy` windows in the
availability response carry no titles at all, and a directory visitor gets none.

## Atomicity

`bookWithoutConflict` opens one interactive transaction. It locks the
participants' `User` rows with `SELECT … FOR UPDATE`, sorted by id so two lockers
cannot deadlock. Only then does it check and write. Two people booking the same
mentor in the same second are serialised, so the result is one meeting and one
409. The InnoDB read view is created by the first *non-locking* read, which runs
after the lock is held, so the check sees the other booking once it has
committed. The PATCH move does the same inline: one transaction per request, with
every target's pair locked.

## Override

`force: true` books over a conflict. It is available to an admin, or to the pair's
mentor. On `PATCH`, a mentor who only created the meeting gets a 403. It is
**never silent**: an `AuditLog` row `meeting.forceConflict` records who forced it
and over what. In the UI, the conflict notice offers "Book anyway" on the
scheduling screens. It never offers it on the request form, because a requester
cannot force.

## Suggested times (#1999)

`GET /api/meetings/suggested-times?relationId=&duration=&count=` is the
proposing side of the same data. It returns times that work for both people:

1. the mentor's posted hours, including one-offs, minus away windows (#2001),
   sliced to the meeting length;
2. minus every attendee's busy windows, with the mentor's widened by their
   buffer (#2003);
3. inside **08:00–20:00 on each attendee's own clock**, because a slot at 03:00
   for the mentee is not a suggestion;
4. within the mentor's notice period and caps;
5. ranked soonest first, with an on-the-hour start counted ahead of a :30 start
   up to 45 minutes earlier.

`src/lib/suggestTimes.ts` is pure and takes the busy windows as an argument. Its
unit tests (`scripts/test/suggest-times.test.mjs`) cover ranking, two zones and a
DST change.

**Who may ask:** an admin of the org, the pair's mentor, or the mentee of an
ACTIVE relation. Anyone else gets a 404. The answer contains only instants and
each person's zone. A busy hour is simply not offered, with no title and no
reason given.

**When nothing is free**, the `reason` names the binding constraint:
`no_hours`, `all_taken`, `outside_hours` or `limit_reached`.

**UI:** a *Suggested times* strip above the date fields in
`MeetingSchedulerPanel` and in the mentee's request panel. Each chip is shown on
the viewer's clock, and the selected one expands into `AttendeeTimes`. Picking a
chip only fills the form. The booking goes through the screen's existing POST,
so the conflict guard and the booking rules still apply.
