# Availability: weekly hours, one-offs, away windows (#1363, #1361, #2001)

A mentor's availability is made of three kinds of row. All of them are read in
the mentor's `User.timezone`; there is no per-slot zone. The reasoning is in the
header of `src/app/api/availability/route.ts`.

| Shape | Row | Offered |
|-------|-----|---------|
| Weekly | `AvailabilitySlot` with `date = null` | Every week, on `weekday` |
| One-off | `AvailabilitySlot` with `date` set | Once, on that date. `weekday` is derived from the date on write and kept non-null so existing queries keep working. |
| Away | `AvailabilityException { startDate, endDate }` | Nothing, on any date in the window (both ends inclusive) |

## Expansion stays pure

`expandSlots(slots, zone, { from, weeks, limit, exceptions })` in
`src/lib/availabilitySlots.ts` walks day by day in the mentor's zone. It skips a
date that falls inside an away window, offers a one-off only on its own date,
and drops anything before `from`. It never queries anything: the caller passes
the exceptions in. Its unit tests (`e2e/availability-slots.unit.spec.ts`) cover
DST, including an away window evaluated on the mentor's date when the UTC date
differs.

## Writes

- `POST /api/availability`: weekly, or a one-off with `date` (a past date is a
  400). Optional `note`.
- `PATCH /api/availability`: `{ id, weekday?, date?, startTime?, endTime?, note? }`.
  It uses the same half-open overlap rule with the edited row excluded, so a slot
  does not collide with itself.
- `DELETE /api/availability?id=`.
- `GET/POST/DELETE /api/availability/exceptions`: away windows, at most a year
  each.

**Overlap** (`findSlotClash`): a weekly slot competes with the weekly slots of
its weekday and with live one-offs on that weekday. A one-off competes with the
weekly pattern of its weekday and with the one-offs of its own date. Otherwise
two rows would offer the same hour twice. The 409 body is
`{ code: 'overlap', clash: { startTime, endTime, date } }`.

**Who**: the mentor themselves, or an ADMIN for a user of their own organization
(`mentorId` on create; the row's owner on edit and delete). Neither model has an
`orgId` or appears in `TENANT_MODELS`, so `src/lib/availabilityAccess.ts` makes
the `mentorId → User` hop on every write. This is the hop whose absence was
#1350.

## Reads and cleanup

`GET /api/availability` returns live rows only: weekly slots, one-offs dated
today or later, and away windows that have not ended, all judged by "today" in
the mentor's zone. Past rows are **filtered on read, not swept**. There is no
cron to forget, and nothing is deleted behind the mentor's back.

A booker (a paired mentee, an admin, or a directory visitor allowed by #1350)
gets the away windows as **dates only**. The reason is the mentor's business. The
portal's slot picker passes them to `expandSlots`.
