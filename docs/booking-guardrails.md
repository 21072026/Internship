# Booking guardrails (#2003)

A mentor draws the line once, and every write path holds it. The rules cover how
much notice a booking needs, how many bookings a week or a month can hold, the
gap between calls, and how long a session lasts. The failure this prevents is the
one that ends volunteer programmes: the most generous mentors get swamped, burn
out and go quiet.

## The row

`MentorBookingPolicy` has exactly one row per mentor (`mentorId @unique`). There
are no copies on `AvailabilitySlot` and no columns on `User`. All values are in
minutes. #1808's CSV import writes `minNoticeMinutes` and `maxPerMonth` into this
row, so the names and units form a contract with it.

| Field | Meaning | Bounds |
|---|---|---|
| `minNoticeMinutes` | Nothing can be booked that starts sooner than this | 0 – 14 days |
| `bufferMinutes` | The minimum gap before and after every other meeting | 0 – 240 |
| `maxPerWeek` / `maxPerMonth` | Bookings per Monday-to-Sunday week, and per calendar month | 1 – 50 / 1 – 200; the month value must be at least the week value |
| `defaultSlotMinutes` | The session length: windows are sliced into blocks of this size, and an accepted request becomes a meeting of this length | 15 – 240 |

`AvailabilitySlot.slotMinutes` overrides the session length for one window.

A null value means no rule. With no row, nothing changes.

## One helper, every path

`findPolicyViolation` in `src/lib/bookingPolicy.ts` is the only enforcement
point. `checkPolicy` in `src/lib/bookingPolicyRule.ts` is the pure judge and is
unit-tested (`scripts/test/booking-policy.test.mjs`). The rules are checked in
this order: notice, buffer, week, month. The first rule broken is the one named
in the response:

```json
{ "code": "policy", "rule": "weekly_cap", "limit": 3, "windowStart": "2026-10-12T00:00:00.000Z" }
```

| Path | Notes |
|---|---|
| `POST /api/meetings` | Runs inside the #1995 lock, through `bookWithoutConflict`'s `extraCheck` hook. A bulk schedule reports each refused invitee with its `policy`, and the rows of one session count once. |
| `PATCH /api/meetings/[id]` | Runs when the time or length changes. The rule is checked once per mentor, with the moved rows excluded. |
| `POST /api/meeting-requests` | The request is refused at once, with the rule named. |
| `PATCH /api/meeting-requests/[id]` (accept) | Runs inside the lock. The meeting gets the mentor's session length. |

**Weeks and months are the mentor's own.** A week starts on Monday at 00:00 and a
month on the 1st at 00:00, both in the mentor's `User.timezone`. A week that
contains a DST change is 167 or 169 hours long, and the boundaries stay correct.

**Caps count bookings, not rows.** A bulk session is one row per invitee sharing
a `batchKey`, and it counts as one booking. Cancelled meetings do not count.

## Who is bound

- **The mentor's own bookings are exempt.** A mentor scheduling with their own
  mentee is not demand, and these are their own lines to cross. This includes a
  mentor accepting a request.
- **Everyone else is bound**: a mentee asking, or an admin scheduling or
  accepting.
- **An admin can override** with `force: true` on `POST`/`PATCH /api/meetings`.
  Every override writes an `AuditLog` row (`meeting.forcePolicy`) recording which
  rule was overridden. A mentor must never exceed a limit they set without it
  being recorded.

## The offer side

The picker stops offering slots that the API would refuse:

- `expandSlots()` takes `slotMinutes` and `minNoticeMinutes`. It stays pure and
  gains parameters, not a database. A 09:00–12:00 window at 30 minutes becomes
  six blocks. A trailing part-block is not offered, and nothing inside the notice
  horizon is offered.
- `GET /api/availability?mentorId=` returns the mentor's busy windows widened by
  the buffer, plus `booking: { slotMinutes, minNoticeMinutes }`. It never returns
  the caps, which would tell the reader how full someone else's week is.

The caps are still enforced on write. An offer can be refused for a full week,
and when that happens the mentee is told so in a sentence.

## UI

- **Booking rules card** on `/mentor/availability`. It is the only place where
  the five inputs are rendered. Notice is typed in hours and stored in minutes.
  The summary line reads back what is saved, for example "Bookings: 30-minute
  sessions, at least 4 hours ahead, up to 3 a week."
- **The refusal names the rule.** The request panel renders the 409 as a
  sentence, such as "Ayşe needs at least 4 hours notice." A bare "failed" is what
  sends people back to email. On the scheduling screens, an admin also sees
  "Book anyway".
