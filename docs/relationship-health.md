# Relationship health (#1898)

**The score is deterministic and published; we do not run a model on your
programme.** Every relationship's health is a 0-100 score computed from a
fixed rules table, the same input always gives the same score, and the table
below is the whole of it. Nothing is learned from anyone's data.

Source of truth: `src/lib/relationHealth.ts` (`HEALTH_RULES`,
`HEALTH_RULES_VERSION`). This page is its human copy, and
`scripts/test/relation-health.test.mjs` fails when the two drift apart.

## The rules (version 1)

| Rule | Weight | Window | Why it is there | Flag |
|------|-------:|--------|-----------------|------|
| `recent_contact` | 25 | reminderDays (org setting, default 14) | A pair that has not been in touch within the reminder window is the strongest early sign a relationship is fading. Full points inside the window, half up to twice the window, none beyond. | `inactive` |
| `stage_deadline` | 15 | the current stage deadline | A stage deadline that has passed means the pipeline promise to the mentee is already broken. | `overdue` |
| `question_answered` | 10 | open questions right now | A mentee question left unanswered is the clearest signal the mentee is waiting on the mentor. | `unanswered_question` |
| `meeting_request_answered` | 10 | pending meeting requests right now | A meeting the mentee asked for and nobody confirmed is a request ignored. | `pending_meeting` |
| `open_work` | 10 | open goals and assigned to-dos right now | A pair with no open goal or to-do has nothing it is working towards. | `no_open_goal` |
| `weekly_reports` | 15 | the last two full weeks, during the internship stage | An intern who has stopped handing in weekly reports has usually stopped engaging with the programme. | `missing_weekly_reports` |
| `stage_movement` | 15 | 60 days | A relationship that has not moved stage in two months is stuck, even if the pair still talks. | `stage_stalled` |

"Contact" is the one rule of `docs/last-contact.md`: an interaction log entry,
a direct message in either direction, or the mentee's own group message.

## Bands

| Band | Score |
|------|-------|
| `HEALTHY` | 70-100 |
| `WATCH` | 40-69 |
| `AT_RISK` | 0-39 |

## A missing signal is not a bad signal

A rule with no data for a relationship **drops out of the denominator**
instead of scoring zero: no stage deadline set, not in the internship stage, a
pair younger than the reminder window that has not been in touch yet or set a
goal yet, a pair younger than 60 days that has never moved stage. A brand-new
pair therefore reads healthy, not red — otherwise every relationship would be
flagged on day one and the score would be ignored before anyone used it. A pair
where no rule has data has no score at all (`null`).

## Who is not scored

- **Dormant first contacts** (`docs/dormant-first-contacts.md`) — an applicant
  who never replied is not a dying relationship.
- **Relations that are not `ACTIVE`** (completed; paused once that exists).

## Score and flags are two different outputs

Each rule returns its points (for the score) and its flag (the reason shown to
people). The flags keep exactly the semantics the mentor attention queue has
always had — `src/lib/mentorAttention.ts` reads its mentorship reasons from this
table, so the queue and any admin health view can never disagree about what is
wrong. Where the score is more forgiving the flag is not: a brand-new pair is
still told "no recent contact" — it just does not lose points for it yet.
`stage_stalled` is not shown in the mentor queue; it is for the admin view.

## Version history

- **1** (2026-10) — the table above.

A change to any weight, window or threshold bumps `HEALTH_RULES_VERSION` and
adds a line here, so a score can always be traced to the rules that made it.
