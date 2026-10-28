# Group sessions and office hours (#1856)

One-to-many sessions — a kickoff briefing, a mentor office hour, an employer info session —
with registration, a cap, a waitlist and attendance. **That is the whole scope.** Booths,
employer bidding, fair sessions, room allocation, ticketing, payments and a public events
directory are a separate product and are deliberately not here.

## Model

- `ProgramEvent` — tenant model (`orgId`, in `TENANT_MODELS`). Optional `programId` (the
  Cohort row): set, only that programme's members see it. `audience` is
  `MENTEES | MENTORS | ALL`. Never deleted: cancelling stamps `cancelledAt`.
- `EventRegistration` — one row per (event, person), `@@unique([eventId, userId])`, reached
  through its event (no `orgId`, unregistered, like `ProgramStepRun`). `state` is
  `REGISTERED | WAITLISTED | CANCELLED`. **No token**: a registrant is a signed-in account,
  so there is no credential that could leak the way #1548's `rsvpToken` did.
- Attendance is `attendance AttendanceState?` + `attendedAt` on the registration — #2014's
  vocabulary, reused. No second attendance enum or table, and `Meeting` gains nothing.

## The seat rule (load-bearing)

`src/lib/groupEvents.ts` is the only writer of seats. Every seat change runs in one
transaction that first locks the event row (`SELECT … FOR UPDATE`):

- **Register** claims a seat with ONE guarded `updateMany` (`seatsTaken < capacity`, or an
  uncapped event). Zero rows → `WAITLISTED`. Two requests for the last seat cannot both win.
- **Cancel** releases the seat and refills it from the waitlist (oldest `registeredAt`
  first) in the same transaction, so nobody jumps the queue in between. The promoted person
  gets `event.promoted`.
- **Capacity** may never drop below `seatsTaken`; raising it fills from the waitlist.

Invariant: `seatsTaken` equals the REGISTERED rows, and a free seat means an empty waitlist.

## Who sees what

`visibleEventsWhere()` is the one filter: admins see every event of their org; mentors and
mentees see published events whose audience includes their role, open to all or to a
programme they are in, plus events they host or hold a registration for. Not visible = 404.
The join link is returned only to the host, admins and REGISTERED people.

## Video

JaaS is 1:1 only (`src/lib/meetingRoom.ts`), so a group session without a pasted link falls
back to the public `meet.jit.si`, whose **embedded** calls end after five minutes. The UI
says so and opens the call in a new tab or asks for the host's own conferencing link.
