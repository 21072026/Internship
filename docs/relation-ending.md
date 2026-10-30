# The agreed end of a pairing (#1784, #1786)

A pairing can carry what the pair agreed to: `MentorshipRelation.expectedEndDate`
(when it is *meant* to end — not `completedAt`, not the stage clock
`stageDeadline`) and `expectedMeetingIntervalWeeks` (the rhythm, #2014). Setting
them: `src/lib/relationSchedule.ts`. This page is what the product does with them.

## The ending-soon nudge

- **Who.** Live, not paused pairings (`activeRelationWhere()`) whose end date is
  within `relationEndingLeadDays` (programme → org → global setting, default 14)
  and whose `endingSoonNotifiedAt` is empty. Rule: `isEndingSoon()` in
  `src/lib/relationEnding.ts`.
- **What.** Both participants: an in-app notice (`mentorship.ending_soon`) and a
  mail in their own language (category `relation-ending`, group
  `mentorship_lifecycle`, so the person's mentorship-mail preference applies).
  The mentor's mail carries a signed one-click "extend by the original length"
  link; the mentee's does not.
- **How once.** `sweepEndingSoonRelations()` (`src/lib/relationEndingSweep.ts`,
  job `reminders.relationEnding`, 09:00) claims the pairing with one guarded
  update (stamp still null, end date unchanged) before telling anyone, and the
  mail carries a dedupe key per recipient and end date.

Two limits are not configurable — the same two as
[dormant first contacts](dormant-first-contacts.md), for the same reasons:

1. **One nudge per end date.** No second chase. Only a NEW end date (an
   extension, or an edit through `PUT /api/mentorship/[id]`) clears the stamp.
2. **No automatic closure and no automatic extension.** A pairing past its end
   date stays as it is until a person ends or extends it.

## Extending

`extendRelation()` (`src/lib/relationExtend.ts`) is the only writer of an
extension. Callers: `POST /api/mentorship/[id]/extend` (ADMIN or the relation's
mentor, server-side; a mentee gets 403) and the mail link (`/m/<token>`, kind
`extend`, POSTed from the page so link scanners do nothing). It moves the date
later, adds one to `durationExtendedCount`, clears `endingSoonNotifiedAt`, writes
a `RelationLifecycleEvent` (reason `extended`, state unchanged) in the same
transaction, raises `mentorship.extended` and tells the mentee. The update is
guarded on the end date the caller saw; the mail link is bound to the date it
announced, so once that date has moved the link answers `409 stale`.

## The below-rhythm signal

`cadenceStatus()`: `behind` once the gap since the pair last met (or since the
start, if it never met) exceeds 1.5 × the agreed interval. Shown on the mentor's
attention queue as `behind_cadence`. Derived, read-only, and **nothing at all**
for a pair that agreed no rhythm (`no_data`) — most pairs.
