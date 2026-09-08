# Changing a mentee's mentor

**Status:** shipped (#2289). Admin-initiated. The mentee-initiated route to the
same outcome is the re-match request (#1801,
[`docs/dormant-first-contacts.md`](dormant-first-contacts.md) is unrelated; the
re-match lives in `src/app/api/mentorship/[id]/rematch/route.ts`).

## The problem this removes

There was no "change this mentee's mentor" operation. The only way was
close-then-create:

1. `PUT /api/mentorship/<id>` with `status: 'COMPLETED'`
2. `POST /api/mentorship` with the new mentor

Three things were wrong with that, and all three were in the data, not the UX:

- **It records a success that never happened.** A pairing the mentee left is
  `COMPLETED`, indistinguishable from one that finished the programme —
  certificate-eligible, counted as a completion. This is exactly the corruption
  #1801 was filed to stop for the mentee's own path.
- **No reason, and no link between the two rows.** Nobody can answer "why did
  this mentee change mentors?" afterwards.
- **Between the two requests the invariant is false.** Do them in the other
  order and the one-active-mentor guard (#419) answers `409 already_mentored` —
  a correct refusal in the middle of a legitimate task, with no supported path
  through it. *A correct guard with no path through it is how people learn to
  fake a completion.*

## The operation

`POST /api/mentorship/<id>/transfer` — **ADMIN only**.

```json
{ "toMentorId": "<user id>", "reasonCode": "wrong_assignment", "reasonNote": "optional" }
```

One request, one `prisma.$transaction`. The rule and both outcomes live in
[`src/lib/mentorTransfer.ts`](../src/lib/mentorTransfer.ts); the route is
authorization plus validation.

A **mentor may not** transfer their own mentee: the receiving mentor never
agreed and the outgoing one would be deciding somebody else's caseload — the
same reason a mentor-facing caller cannot decide a re-match (#1801). A mentee
who wants a different mentor files a re-match, which goes through the admin
queue.

### Two outcomes, decided from the data

Which one applies is **not a choice the admin makes**. It is a property of the
pairing, read as `_count` over its child collections
([`src/lib/relationHistory.ts`](../src/lib/relationHistory.ts), unit-tested):

| | `mode: 'corrected'` | `mode: 'transferred'` |
|---|---|---|
| when | the pairing has **no** rows in any tracked collection | anything at all was recorded |
| what happens | `mentorId` is repointed **in place** | old relation closed, new one created |
| old relation | unchanged, still `ACTIVE`, no `completedAt` | `COMPLETED` + `lifecycleState: ENDED_REASSIGNED` + `endReasonCode` |
| new relation | none | `previousRelationId` → the closed one |
| the record of the mistake | the `ActivityLog` entry, and only that | the closed relation itself |

`'corrected'` is the mis-assignment case — the admin picked the wrong name in
the assign dialog. Nothing happened under that pairing, so there is nothing to
preserve, and a closed relation standing as the record of a mentorship that
never began is its own small lie. The tracked collections are `interactions`,
`statusChanges`, `meetings`, `messages`, `evaluations`, `goals`,
`meetingRequests`, `questions`, `relationNotes`, `offers`, `weeklyReports`.
`weeklyReportReminders` is deliberately **not** among them: it is a bookkeeping
row the system writes on its own, and a cron run must not be what makes a
mistake un-correctable.

### What moves, and what does not

**Nothing moves.** Every child row stays on the relation it was written under.

That is not laziness, it is attribution: `InteractionLog` has **no author
column** — a logged meeting is attributed purely through `relation.mentorId`.
Re-pointing `mentorId` on a pairing that carries history would silently credit
every meeting mentor A ran to mentor B, and any per-mentor reporting built on
`relation.mentorId` would report it. Private `relationNotes` are the same
question from the other side: a note mentor A wrote to themselves is not B's to
read.

What the new relation **does** carry forward is the mentee's own journey:
`pipelineStatus`, `stageDeadline`, `companyId`, `projectId`, `cohortId`.
Resetting a hired-track candidate to the first stage because their mentor
changed is a second falsehood, and the one the whole pipeline board would show.

`previousRelationId` is the seam that makes the predecessor **readable** rather
than merely still existing somewhere. What still reads only the live relation:
`pickMenteeRelation` (`src/lib/menteeRelation.ts`) and therefore `/portal`,
`/portal/goals` and `/portal/journey`, plus the mentor's own mentee views and
`GET /api/mentorship/[id]/timeline`. **Making those walk the chain is the
follow-up** — the column is stored and honest today, and no reader is required
to use it yet.

### The guard, inside the transaction

`findActiveMentorship(tx, menteeId, { exceptRelationId: id })` is re-asked
**inside** the transaction that writes — `src/lib/activeMentorship.ts` takes a
`TransactionClient` for exactly this, and `exceptRelationId` exists because the
relation being changed is part of the comparison. A rollback is what keeps the
mentee from ending up with two live mentors or with none, and this indivisibility
is the whole point: close-then-create over two HTTP requests is also the shape
that would trip the future `@@unique([activeMenteeKey])` backstop (#2286).

Both writes match on `status: 'ACTIVE'`, so a concurrent "Mark complete" makes
the update hit zero rows (`P2025`) and rolls everything back rather than quietly
reviving a closed pairing.

### What it deliberately does not do

- **No plan gate.** The tenant's `ACTIVE` count is unchanged — one closes as the
  other opens — so a tenant at its limit can still fix a wrong assignment or
  replace a mentor who left. Same reasoning as an approved re-match.
- **No capacity block.** `mentor_at_capacity` / `mentor_not_accepting` come back
  in `warnings`, advisory exactly as on `POST /api/mentorship`. An admin moving
  a mentee off a mentor who left has to be able to put them somewhere.
- **No webhook.** `mentorship.created` would be a lie in `'corrected'` mode, and
  direct `dispatchWebhook` call sites are capped at ten by `npm run check:events`
  (#1697). A `mentorship.transferred` event belongs to the catalogue that guard
  exists to make room for.
- **No automatic stage change and no certificate.** `endedByMentorChange()`
  keeps both `ENDED_REASSIGNED` and `ENDED_REMATCHED` out of certificate
  eligibility (`src/lib/certificateEligibility.ts`): the pairing ended, the
  programme did not finish.

## Who is told what

Three people, three different true things, and **none of them the reason**:

| | in-app | e-mail |
|---|---|---|
| mentee | `mentorship.mentorChanged` (names the new mentor) | `sendMentorAssignedEmail` |
| incoming mentor | `mentorship_request.menteeAssigned` | `sendMenteeAssignedEmail` |
| outgoing mentor, `'transferred'` | `mentorship.reassignedAway` | `sendRematchMentorNoticeEmail` |
| outgoing mentor, `'corrected'` | `mentorship.assignmentCorrected` | none |

The outgoing mentor's mail is the re-match notice on purpose: its copy is *"your
mentorship with X has ended — they are continuing with another mentor"*, which
is true of both paths and says nothing about who decided or why. A corrected
mis-assignment sends no mail at all — there is no mentorship to tell them ended.
No echo to whoever pressed the button (#886).

**The reason is not shown to either mentor.** #1801 makes that a rule for the
mentee's re-match reason, and the mirror case deserves the same answer: a candid
reason only stays candid if it is not read back by the person it is about.

## Where the reason lives

`MentorshipRelation.endReasonCode` — a code from `ADMIN_END_REASON_CODES`
([`src/lib/relationLifecycle.ts`](../src/lib/relationLifecycle.ts)), which is
the mentee-facing `END_REASON_CODES` **plus** `wrong_assignment` and
`mentee_request`. A superset, not a rival vocabulary: those two are not things a
mentee picks in the re-match form, and putting them in the shared list would
offer them there.

**There is no free-text column on the relation, on purpose.** Several read paths
return a relation's scalars to the mentor or the mentee (they use Prisma
`include`, which selects every column), so prose stored there would reach the
very person it is about. The admin's note goes to the `ActivityLog` entry
(`mentorship.transferred` / `mentorship.mentor_corrected`), which only admins
read — and in `'corrected'` mode that entry is the **only** record that the
wrong mentor was ever assigned, since the relation itself no longer says so.
A coarse code on the relation is the same kind of fact `StatusChange.reasonCode`
already exposes on those paths.

`other` requires the note (`code: 'note_required'`) — the same rule the drop-off
reasons apply. A reason nobody can read later is not a reason.

## The admin surface

`/admin/mentorship` — **Change mentor** on every `ACTIVE` row, next to
*Mark complete*. The dialog picks the new mentor and a reason, states which of
the two outcomes will apply, and reports which one happened. Test ids:
`change-mentor-<relationId>`, `change-mentor-dialog`, `change-mentor-select`,
`change-mentor-reason`, `change-mentor-note`, `change-mentor-submit`,
`mentorship-notice`.

The list also badges `ENDED_REASSIGNED` and `ENDED_REMATCHED` rows
(`lifecycle-badge`) instead of rendering them as a plain "Completed" like a
mentorship that actually finished.

And the wall is now a door: when `POST /api/mentorship` refuses with
`already_mentored`, the body carries `activeRelationId` and `activeMentorName`
(added by `alreadyMentoredBody`, ADMIN-facing callers only), so the assign
dialog names the mentor in the way and offers the change instead of leaving the
admin to work out the sequence. `error` and `code` are byte-identical to what
that route always answered.

## Refusal codes

| code | status | meaning |
|---|---|---|
| `inactive_relation` | 409 | the pairing is not `ACTIVE` (or was closed mid-flight) |
| `already_mentored` | 409 | some **other** live pairing exists for this mentee |
| `same_mentor` | 400 | that is already their mentor |
| `self_mentor` | 400 | nobody mentors themselves |
| `invalid_mentor` | 400 | inactive, or not an `ADMIN`/`MENTOR`/`MENTEE` |
| `invalid_reason` | 400 | not in `ADMIN_END_REASON_CODES` |
| `note_required` | 400 | `other` with nothing written down |

All of them are translated by the one shared resolver,
`src/lib/mentorshipAssignmentError.ts` — switch on `code`, never on the status,
and never render the server's English `error` literal.

## Tests

- `scripts/test/mentor-transfer.test.mjs` — the mode predicate, the reason
  vocabularies, and a check that the predicate's key list and the Prisma
  `_count` select still name the same collections.
- `e2e/mentor-transfer.spec.ts` — a mis-assignment corrected in place, a pairing
  with history handed over (stage carried, chain set, history left where it was),
  and the `already_mentored` body naming the current mentor.
