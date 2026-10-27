# Mentor load controls (#1808)

A mentor's willingness is more than one number:

| Knob | Lives on | Who it binds |
|------|----------|--------------|
| `mentorCapacity` | `User` | every new pairing (advisory for admins, binding on the apply link) |
| `acceptingMentees` | `User` | the mentor's own on/off switch |
| `selfMatchLimit` | `User` | **self-selection only** — the directory's preferred-mentor request and the public apply link |
| `minNoticeMinutes`, `maxPerMonth`, … | `MentorBookingPolicy` (#2003) | every booking write path (`assertBookingAllowed()`) |

## The rule

`getMentorAvailability()` (`src/lib/mentorAvailability.ts`) is still the one judge.
It takes an optional `context`:

- omitted / `'admin'` — the pre-#1808 answer, bit for bit; `selfMatchLimit` is ignored.
  `e2e/mentor-load-controls.unit.spec.ts` pins this against a copy of the old derivation.
- `'self_select'` — an otherwise `available` mentor whose `selfSelectedCount` has reached
  `selfMatchLimit` reads `self_match_full`. A stronger status (`at_capacity`,
  `not_accepting`) is never masked. `null` limit = no separate limit; `0` closes
  self-selection entirely.

## What holds a self-selected seat

`countSelfSelected()` (pure) over rows read by `selfSelectedCounts()`
(`src/lib/selfMatchSeats.ts`, the only reader): a `MentorshipRequest` naming the mentor as
`preferredMentorId` that is `PENDING`, or `APPROVED` while its mentee is still `ACTIVE`
with that same mentor. An admin who approved the request onto someone else freed the
seat. Each mentee counts once. No column records "how this pairing started", so the seat
is derived — nothing to backfill.

## Where it is enforced

- `POST /api/mentorship-requests` — a preferred mentor at the limit → `409 mentor_self_match_full`.
  Capacity and the on/off switch stay advisory on that path, as before.
- `/api/apply` (GET and POST) — the link closes, answering `mentor_full`.
- `GET /api/mentors` — for a MENTEE viewer the card reads `self_match_full` and drops out
  of `accepting=1`. MENTOR/ADMIN viewers see the plain capacity answer.
- The matching engine — `capacityHeadroom` with `config.selfSelect: true`; an admin round
  (the default) still ranks the mentor.

Admin assignment, transfer, invite and request approval are never subject to it.
