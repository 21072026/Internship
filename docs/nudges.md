# Nudges — admin-authored reminders (#1684)

A **nudge rule** says: *to the people this segment describes, when this trigger fires,
after this delay, send this message — at most so often.* The authoring screen is
`/admin/nudges` (#1686); this page is the engine.

| Piece | File |
|---|---|
| Vocabulary, write-time gate, per-person decision (pure) | `src/lib/nudges/rule.ts` |
| Segment → Prisma `where` (the only place) + exact relation check | `src/lib/nudges/segment.ts` |
| Evaluator, scan, send job (Prisma) | `src/lib/nudges/evaluate.ts` |
| Event subscriber | `src/lib/events/subscribers/nudge.ts` |
| Jobs | `nudge.evaluate` (daily 09:20 UTC, after the dormancy sweep), `nudge.send` |
| Models | `NudgeRule`, `NudgeSend` (both tenant models) |

## Triggers

- **Event** — one of `NUDGE_EVENT_TRIGGERS` (`mentorship.created`, `relation.created`,
  `interaction.logged`, `evaluation.added`, `meeting.completed`,
  `mentorship.lifecycle_changed`). The event's relation gives two candidates, its mentor
  and its mentee; the segment filters them. `delayMinutes` is the send job's `runAt`
  (event time + delay).
- **Scan** — the daily `nudge.evaluate` job runs the segment over the org's people.

**Stage changes are not nudges.** `pipeline.stage_change` (and every other stage event)
is refused when a rule is stored (`stage_trigger`): "when a relation enters stage X" is an
`AutomationRule` (#1703, `src/lib/automation/`).

## Segment

Allowlisted conditions only, each `{ field, op, value }` (`SEGMENT_FIELDS`): `role`
(MENTOR | MENTEE — nobody else is ever a recipient), `stage` (in / notIn),
`daysInStage` (gte / lte, judged by the one stage clock), `daysSinceLastInteraction`
(gte), `cohort` (in), `tag` (has / notHas), `hasNoMentor`. The zod schema is strict: an
unknown field, operator or value shape is refused at write time and again when a stored
row is read back. `segment.ts` maps each field to a fixed column — no request value is
ever passed through as a `where`.

## Who is dropped, and why

`planRecipients()` decides per person, in this order (the dry run reports the counts):

1. **`dormancy`** — a mentee with a dormant first contact. Hard limit:
   [dormant-first-contacts.md](dormant-first-contacts.md) allows two "still interested?"
   mails, ever; a nudge would be the third.
2. **`outcome`** — a mentee whose active relation is at an ending (an outcome-mail stage,
   a "reached the outcome" stage or a terminal one). Hard limit: outcome copy is the
   mentor's, written once (#830). A segment that targets such a stage is refused at write
   time (`outcome_stage`).
3. **`already_sent`** — this rule already sent this person this dedupe key
   (`evt:<eventId>`; a scan rule's key is `scan`, so a scan rule reaches a person once).
4. **`unsubscribed`** — the reader switched the channel off (`task_reminders` mail group,
   `interactions` in-app category).
5. **`cooldown`** / **`cap`** — counted over **every** nudge the person got in this org,
   not only this rule's: fatigue is a property of the inbox.

Mail goes through `sendEmail()` (category `nudge`): the unsubscribe check, the outbound
approval hold (`OUTBOUND_CATEGORIES.nudge`, held for a lead under `lead_mail`),
suppression and the EmailLog row all apply. Nudges never reach a COMPANY login, so the
B2B advertising gate (`canSendMarketingEmail()`) is not reached; a recipient role added
later must call it.

## At-least-once

A redelivered event or a second scan produces the same keyed `nudge.send` job. The send
job re-checks the person against the rule *now*, then **claims** the `NudgeSend` row
(unique on rule × person × dedupe key) before it delivers — a rerun loses the claim and
sends nothing. If delivery throws, the claim is released for the retry (an in-app copy
already created may then appear twice; mail is never sent twice by the claim).

## Dry run

`evaluateNudgeRule(rule, { writer: DRY_RUN_WRITER })` is the same call with a writer that
does not write: the audience, a sample and the drop counts, no job and no `NudgeSend`.
