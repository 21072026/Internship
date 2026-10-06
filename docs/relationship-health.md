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

## History and alerts (#1901)

- **One snapshot per relation per UTC day.** The nightly sweep
  (`src/lib/jobs/relationHealthSweep.ts`, 02:00, and
  `GET /api/cron?job=relation-health` for an admin's own org) scores every
  `ACTIVE` relation and upserts `RelationHealthSnapshot(relationId, takenOn)` —
  a re-run the same day updates the row, never adds one. Snapshots older than
  **180 days** are pruned by the same sweep.
- **Trend.** `GET /api/admin/relation-health/[id]?days=90` returns the measured
  daily series (never interpolated), the 7- and 30-day delta (against the latest
  snapshot on or before that day) and the latest reasons — numbers only; screens
  draw them with the product's own CSS bars, no chart library.
- **Alerts: one per crossing.** A pair whose band moved into `AT_RISK` since
  yesterday goes into one daily digest mail per admin of its org, listing each
  pair with its mentor, its stage **label** and its **reasons** in the admin's
  language ("no contact for 24 days · stage deadline passed"), never a bare
  number. A pair that stays red is not alerted again the next night — only after
  it recovers and falls again, or 30 days after its last alert. No snapshot
  yesterday is a baseline, not a crossing, so the first sweep after a deploy
  mails nobody.
- **Opt-out.** The digest is the e-mail category `program-health` in the
  *Reports & analytics* group (`src/lib/emailGroups.ts`): an admin who switched
  analytics reports off gets neither. (A separate in-app notification category
  was not added — `NOTIFICATION_CATEGORIES` is frozen, #2348 decision 4.)

## The admin monitor: /admin/health (#1902)

The org-wide sibling of the mentor's attention queue (which is unchanged): every
`ACTIVE` relation in the admin's tenant, scored **now** — the same computation
the nightly sweep runs (`src/lib/relationHealthLive.ts`, shared by both), so the
screen and the snapshot never disagree about what a signal means.
`GET /api/admin/health` (ADMIN only, checked in the handler; closed for a vertical
without the `mentorship` capability, like the page) takes `band`, `mentorId`,
`cohortId`, `stage`, `page`, `pageSize`.

- **Worst first:** band, then score (a pair too new to score last in its band),
  then the number of reasons, then the longest silence (`compareHealthRows`).
- **Listed = has a reason.** A pair with nothing wrong has nothing to do; it is
  counted ("N relationships with nothing to do are not listed"), as are dormant
  first contacts and non-active relations — the footnote under the list, so a
  short queue never looks like a broken one.
- **Counters** honour every filter except the band, plus how many pairs crossed
  into `AT_RISK` in the last 7 days — read from the snapshot history (an
  `AT_RISK` day after a non-`AT_RISK` one), not from the alert mark, so a
  crossing the baseline rule did not mail still counts.
- **Exactly one next action per row, and it is a destination**
  (`src/lib/healthNextAction.ts`, in this order):

  | Situation | Action | Goes to |
  |---|---|---|
  | The mentor's account is deactivated | Reassign the mentee | `/admin/mentorship?transfer=<id>` — opens the change-mentor dialog (#2289) |
  | No contact for 60+ days (or ever, on a pair that old) | Record a drop-off reason | the candidate page's mentorship card (`#relation-stage`) |
  | An unanswered question or meeting request | Message the mentor | opens the DM with the mentor |
  | The stage deadline passed | Set a stage deadline | `#relation-stage` |
  | No contact / no weekly reports / nothing open | Message the mentor | opens the DM |
  | The stage has not moved in 60 days | Set a stage deadline | `#relation-stage` |

- **Trend column:** the last 30 measured days as the product's CSS bars and the
  30-day delta, from the snapshots above.
- **Negative feedback flag (#2046).** When the newest open-text summary on
  `/admin/insights` (evaluation comments, weekly-report blockers; at most
  `FEEDBACK_FLAG_WINDOW_DAYS` = 30 days old) has a theme whose sentiment is
  `negative`, every pair whose rows sit in it gets a *Negative feedback: <theme>*
  chip that links to Insights (`src/lib/insights/feedbackFlags.ts`; the rule is
  `feedbackFlagRule.ts`).
  - It is a **note, not a rule.** It does not enter the score, the band, the
    snapshot or `HEALTH_RULES_VERSION`. Nothing on the relation is written, so
    the published rules table above stays exactly true.
  - It **lists** a pair that has no other reason, because a cluster of negative
    feedback is something to read. Such a pair is not counted as quiet.
    `counts.feedback` says how many pairs carry one.
  - Only the newest summary of each kind counts, and only `negative`; `unclear`
    never flags. It is read at request time from the artefacts, so it disappears
    on its own when the next summary no longer finds the cluster, at the org's
    retention, or when an erasure wipes the org's open-text artefacts.

## Version history

- **1** (2026-10) — the table above; nightly snapshots and at-risk alerts added without changing the rules (#1901).

A change to any weight, window or threshold bumps `HEALTH_RULES_VERSION` and
adds a line here, so a score can always be traced to the rules that made it.
