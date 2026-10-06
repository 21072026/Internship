# Programme health scorecard (#1908)

The card at the top of `/admin/analytics` answers "is this programme healthy?"
with named indicators, a green/amber/red band on each against a documented
threshold, and — for every amber or red row — a link to the screen where it is
fixed. A coordinator should leave with a task, not a feeling.

- **One table.** Thresholds, the band rule and the next actions live in
  `src/lib/programScorecard.ts` (pure, unit-tested in
  `scripts/test/program-scorecard.test.mjs`, which also checks this table
  against the code). Every threshold carries its reason in a comment there.
- **Counts the customer can check.** `src/lib/programScorecardData.ts` loads
  them for the caller's tenant; `GET /api/admin/analytics/scorecard` (ADMIN,
  free on every plan) returns each row with the value and the count behind it.
- **Never a misleading 0.** With fewer than **5** items behind a ratio
  (`MIN_TO_JUDGE`) a row reads "not enough data". An indicator with no data
  source yet reads "not yet measurable" and names the work that will make it
  measurable.
- **Everywhere a sponsor looks.** The same rows are on the screen, in the
  print report (`/admin/analytics/report`) and as the first sheet of both XLSX
  exports.

## The indicators

Bands are inclusive on the good side: a value **at** the green line is green.

| Key | Measures | Green at | Direction | Amber at | Fixed at |
|---|---|---|---|---|---|
| `activation` | invitations of the last 90 days with a known outcome (used, or expired unused) that were used, % | 60 | higher is better | 40 | `/admin/invite` |
| `matchRate` | active mentee accounts with an active mentor, % | 80 | higher is better | 60 | `/admin/mentorship` |
| `timeToFirstMeeting` | median days from start to the first non-cancelled meeting, relationships started in the last 180 days that have met | 14 | lower is better | 28 | `/admin/meetings` |
| `meetingCadence` | active relationships older than 30 days with a non-cancelled meeting in the last 30, % | 70 | higher is better | 50 | `/admin/meetings` |
| `stalledPairs` | active relationships older than 60 days with no stage change in 60 days, % | 10 | lower is better | 25 | `/admin/health` |
| `atRisk` | active relationships in the AT_RISK band of the published health rules (`docs/relationship-health.md`), % | 10 | lower is better | 20 | `/admin/health?band=AT_RISK` |
| `surveyResponseRate` | survey invitations sent 7–90 days ago (both reminders have had their chance) that were answered, % | 50 | higher is better | 30 | `/admin/surveys` |
| `nps` | Net Promoter Score (−100..100) of the last 90 days, every survey's first NPS question pooled — a survey counts only once its own answers reach its own floor (#1910) | 30 | higher is better | 0 | `/admin/surveys` |
| `evaluationCoverage` | INTERIM/FINAL evaluations due 7–90 days ago (`EvaluationDue`, #1891 — both reminders have gone out) that were written, % | 80 | higher is better | 50 | `/admin/mentors` |

## Not yet measurable

Nothing, since #1891 gave evaluations a due date. The mechanism stays
(`NOT_YET_MEASURABLE`): an indicator whose data source does not exist yet is
listed with the work that will make it measurable, never shown as a 0.
