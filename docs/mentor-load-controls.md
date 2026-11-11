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

## The roster import (`POST /api/admin/mentors/limits/import`)

The panel on `/admin/mentors` posts a CSV: `email` plus any of `mentorCapacity`,
`selfMatchLimit`, `acceptingMentees` (written onto `User`) and `minNoticeMinutes`,
`maxPerMonth` (written onto the mentor's `MentorBookingPolicy` row, upserted by
`mentorId` — #2003's names and units, minutes not hours; no parallel columns on `User`).

- Runs on the one engine (`runImport()` + `parseDelimited()`, `src/lib/importPreview.ts`):
  the pure half is `src/lib/mentorLimitsImport.ts`, the Prisma half
  `src/lib/mentorLimitsImportStore.ts`. `apply` absent = dry run, the same call with a writer
  that does not write; `apply: true` is the confirmed second call.
- Empty cell = leave as is; a single `-` clears (null = no limit). Bounds are the edit
  screens' bounds (`/api/profile`, `POLICY_LIMITS`). A monthly cap under the mentor's weekly
  one is skipped (`below_weekly`), as `PUT /api/availability/policy` refuses it.
- Per row: `UPDATE` (with `changed`), `UNCHANGED`, `SKIP` (`not_found` — never created —,
  `not_a_mentor`, `duplicate_row`, `no_values`, `below_weekly`) or `ERROR` (each bad column named).
  An unknown column refuses the whole file.
- ADMIN only, checked in the handler; `mentorship` capability; never plan-gated.

## The screening gate before an account (#1807)

Between a mentor application and an account sits an optional, admin-only screening record:
a checklist (`referencesChecked`, `identityVerified`, `expertiseVerified`, `interviewDone`,
`backgroundOk`, each stamped with who/when by the server), the interview (date + notes) and one
reference (name, contact, outcome). The org setting `mentorScreeningRequired` names the items
that must be done before approval; `PATCH /api/mentor-applications/[id]` (`approve`) answers
`409 screening_incomplete` with `missing` otherwise. Empty (the default) = approval as before.
The rule is `src/lib/mentorScreeningRule.ts`. The applicant receives none of it — only the
existing under-review and decision mails — and the notes and reference are erased with the
application.

## Mentor Offers (#1809)

The supply side volunteering: a mentor with headroom offers to mentor an unmatched mentee.

- **Who can be reached:** only a MENTEE with `User.openToOffers` on (off by default, switched on
  the `/portal` panel), active, with no ACTIVE relation and no PENDING request. Nobody else is
  listed on `/mentor/offers`, and a direct POST for them answers 404. The listing carries profile
  fields only (`OFFERABLE_MENTEE_SELECT`), never an address. This is not a mentee directory.
- **Who may offer:** `getMentorAvailability()` must read `available` (capacity, the on/off
  switch). No second offer to the same person while one is pending or after a decline.
- **Quota (not configurable):** 3 PENDING, 5 created per rolling 7 days — `OFFER_LIMITS` in
  `src/lib/mentorOfferRule.ts`.
- **Accepting** claims the offer (`PENDING → ACCEPTED`, guarded) and approves a fresh request
  naming the mentor through `decideMentorshipRequest()`: the plan gate, #419's one-active-mentor
  guard and both sides' notices are the shared ones. A refusal removes that request and reopens
  the offer. Declining asks for nothing; the mentor is told "declined".
- **Mail:** at most two per offer — the offer and one reminder in its last 3 days
  (the morning `requests.expirySweep`, 09:10, which expires mentorship requests (#1775) and offers in one job; the reminder is claimed on `remindedAt: null`). Category
  `mentor-offer` (mentorship_lifecycle group), after `emailAllowed` and
  `emailGroupAllowedForCategory`; never sent once the mentee switched the opt-in off.
- **One clock for both directions of an ask:** an offer waits `REQUEST_TTL_DAYS` (14) like a
  mentorship request (#1775), and "the mentee has a request waiting" means #1775's
  `livePendingRequestWhere()` — a PENDING request past its expiry no longer blocks an offer,
  even before the sweep has marked it EXPIRED. The request an accepted offer creates carries
  its `expiresAt` like every other create path.
- Still open: #1789's `MatchDecision` is not on `main`; when it lands, the accept path writes one
  (`MENTEE_PREFERENCE`).