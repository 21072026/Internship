# Business-day stage SLAs

Story #1633, task #1638. Stage service levels (`StageSla`, #817) count **calendar
days** unless an org or a programme opts into **business days**.

## The rule: `prisma/business-days.mjs`

One pure implementation, plain ESM with JSDoc types, so the request path
(`src/lib/stageSla.ts`), the admin's SLA save and the deadline fill
(`prisma/stage-deadline-fill.mjs`) share it; `src/lib/businessDays.ts` only adds
TypeScript types (allowJs, the stage-deadline-fill precedent).

- `slaDeadline(from, days, rule)` — `calendar` (or no rule) is exactly
  `from + days × 24h`, byte-identical to before. `business` calls
  `addBusinessDays()`.
- `addBusinessDays(from, n, { workingDays, holidays, timeZone })` walks forward from
  the **local** calendar day of `from` in `timeZone`, counting only working weekdays
  that are not holidays, and keeps the local wall-clock time: a 3-business-day SLA
  started Thursday 17:00 is due Tuesday 17:00. A holiday on a non-working day was
  never counted, so it cannot extend the deadline twice. DST-safe (the local time
  is kept across the change).
- `scripts/test/business-days.test.mjs` pins Thursday→Tuesday, a holiday, a holiday
  on a Saturday, a run of consecutive holidays, both Berlin DST changes, a weekday
  judged in Istanbul rather than UTC and custom working days.

## Settings (programme → org → global)

| key | default | |
|---|---|---|
| `slaDayMode` | `calendar` | `calendar` \| `business` |
| `slaWorkingDays` | `1,2,3,4,5` | JS weekdays, 0 = Sunday |
| `slaTimeZone` | `''` | IANA zone; empty = `APP_TIMEZONE` |
| `slaHolidayCalendarId` | `''` | one of the org's `HolidayCalendar`s |

`resolveSlaDayRule({ orgId, cohortId })` (`src/lib/stageSla.ts`) reads them for a
relation's programme (its cohort). A calendar id that is not the org's reads as no
calendar — a setting can never pull in another tenant's dates. `calendar` mode never
reads a holiday.

## Holiday calendars

`HolidayCalendar` (tenant model, `orgId`, in `TENANT_MODELS`) + `Holiday` (a local
`@db.Date` + label, unique per calendar, reached through its calendar). Entered as a
pasted `YYYY-MM-DD, label` list (`parseHolidayList()`); no third-party holiday API.
Limits: 20 calendars per org, 400 dates per calendar.

Routes (all `org.settings.write`, org from the session, another org's id is 404):
`GET/PUT/DELETE /api/admin/sla-day-mode` (the four settings for the org or
`?programId=`; DELETE returns a programme to inheriting) and
`GET/POST /api/admin/holiday-calendars`, `PUT/DELETE /api/admin/holiday-calendars/[id]`
(PUT replaces the whole list in one transaction).

The screen is the **"How SLA days are counted"** card under the SLA editor on
`/admin/settings` (`src/components/admin/SlaDayModeCard.tsx`), with a live preview
computed by the same pure function.

## Where it applies

- Every stage move (`stageDeadlineUpdate()` → `stageChangeEffects`, win-back, trial
  expiry, the account-event feed).
- The admin's SLA save fills missing deadlines with each relation's programme rule
  (`fillOrgStageDeadlines(…, { dayRuleFor })`).
- The overdue mail to the mentor says when its date was counted in business days.

Not changed on purpose: the once-per-environment deploy backfill
(`prisma/backfill-stage-deadlines.mjs`) passes no rule, so it stays in calendar days —
it ran before any org could choose business days. The escalation rung
(`escalateAfterDays`) and the pause/resume carry-over stay calendar days: they measure
how long a breach has stood, not a working deadline.
