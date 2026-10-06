# Evaluation due dates and reminders (#1891)

Nothing used to ask a mentor to write the INTERIM or FINAL evaluation, so the
competency data an org configured in `/admin/settings` was voluntary. Now each
relation gets a due date per type from the org's own pipeline, and the mentor
is reminded — twice at most.

## The schedule — the tenant's own stages

`/admin/settings` → **Evaluation schedule** (settings `evaluationInterimStage`,
`evaluationInterimDays`, `evaluationFinalStage`):

| Type | Due | Built-in default |
|---|---|---|
| INTERIM | `evaluationInterimDays` days after the relation **entered** `evaluationInterimStage` | `INTERNSHIP_IN_PROGRESS_450` + 30 days |
| FINAL | on entering `evaluationFinalStage` | `INTERNSHIP_COMPLETED_490` |

- A stage is a **key** of the org's resolved pipeline, never a label. `''`
  means the built-in default **only if this pipeline still has that key**; a
  renamed or custom pipeline without it gets no reminders until it picks its own
  stage — the sweep never guesses (`resolveEvaluationSchedule`,
  `src/lib/evaluationDueRule.ts`). `'off'` switches a type off.
- `PUT /api/admin/settings` refuses a key the org does not have (**400
  `unknown_stage`**): it would silently never fire.
- **Entered** = the first `StatusChange` into the stage; a relation created
  straight into it counts from its start date.

## The sweep

`sendEvaluationReminders()` (`src/lib/evaluationDue.ts`, daily 08:15 UTC from
`/api/cron/start`; `GET /api/cron?job=evaluations&at=…` for an admin's own
org):

1. **Creates the due rows.** `EvaluationDue` is unique on (relation, type) —
   the unique is the claim, so two sweeps create one row. A relation whose
   evaluation of that type already exists gets its row created completed.
   **No backfill:** a due date already more than 14 days past when first seen
   is not created, so switching this on does not mail every mentor about last
   year's internships.
2. **Reminds the mentor** — on the due date, then once more a week later (and a
   week after the first), **never a third time** (`EVALUATION_MAX_REMINDERS =
   2`). Each reminder is claimed by one conditional UPDATE on `remindersSent`.
   In-app through the existing `goalsEvaluations` category, by e-mail in the
   existing `goals-evaluation` category — no new opt-out. **Only the mentor**,
   never the mentee. A vertical without the `evaluations` capability is not
   swept.

## Stops on write

`POST /api/evaluations` stamps `completedAt` when the **mentor or an admin**
writes that type (`markEvaluationCompleted`) — the reminders stop at once, and
nothing polls for it. The mentee's own review of their mentor is not that task
and stamps nothing. The sweep re-checks before it sends, for an evaluation
written by any other path.

## Where else it shows

- **The mentor's attention queue** — `evaluation_due` while a row is past due
  and unwritten; it leaves the moment the evaluation is written.
- **Coverage** — `evaluationCoverage(tenant)`: of the evaluations that fell due
  in the last 90 days and are at least a week past due, how many were written.
  The input the programme scorecard's `evaluationCoverage` row (#1908) needs.
