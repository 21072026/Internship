# Migrating a programme that is already running (#2073)

Nobody switches platforms between cohorts. They switch mid-programme, with live
pairs, months of session notes and a stage each pair is sitting in. This is the
tool that moves all of that in one go, instead of the buyer recreating it by hand.

`POST /api/admin/migrate` takes ADMIN only and is an internship module (`mentorship`
capability). It runs on the shared import engine (`src/lib/importPreview.ts`,
#2072). The rules are in
[`src/lib/migration/migrationRules.ts`](../src/lib/migration/migrationRules.ts),
which is pure and unit-tested in `scripts/test/migration-rules.test.mjs`. The
database half is
[`src/lib/migration/runMigration.ts`](../src/lib/migration/runMigration.ts).

## The screen: `/admin/migrate`

Upload → map columns → map stages → preview → confirm. All of it is per-run
input; nothing about a mapping is stored.

- **Upload** one CSV per sheet (`migrate-upload-<sheet>`). The header row is read
  in the browser with the same parser the server uses.
- **Columns** are *proposed* by `suggestMapping`, which matches the header
  against the words an export uses for each field in EN/TR/DE (`E-Posta`,
  `Ad Soyad`, `Rolle`, `Stajyer`, `Aşama`, `Datum`, …). The admin corrects them
  (`migrate-mapping-<sheet>-<field>`; the sheet is in the id because three sheets
  share `mentorEmail` and `menteeEmail`).
- **Stages** lists every distinct source stage in the history sheet
  (`sourceStages`), each with a choice of this organization's stages
  (`GET /api/admin/migrate`) (`migrate-stagemap-<source>`). An exact key of ours
  is preselected; everything else starts **unmapped** and stays an error row
  until someone picks a stage.
- **Preview** (`migrate-preview`) shows each sheet in the shared `ImportPreview`,
  with missing required columns named above it. **Migrate now**
  (`migrate-confirm`) appears only after a preview and is disabled while a
  required column is missing. A notice about not sending e-mail stays on screen
  throughout (`migrate-no-mail`).

## The four sheets

Each sheet is one CSV text. The delimiter is sniffed (`,` `;` tab `|`), and a
BOM, CRLF and quoted newlines are all fine. Every sheet is optional. They are
processed in this order, because later sheets refer to earlier ones:

| Sheet | Fields (**required**) | Key for a re-run |
|---|---|---|
| `people` | **email**, fullName, **role**, phone, university, department | lower-cased e-mail |
| `pairs` | **mentorEmail**, **menteeEmail**, status, startDate | (mentor e-mail, mentee e-mail) |
| `stageHistory` | **mentorEmail**, **menteeEmail**, fromStage, **toStage**, **date** | the pair, the target stage, the timestamp |
| `interactions` | **mentorEmail**, **menteeEmail**, **date**, **type**, subject, **notes** | the pair, the timestamp, the type, the text |

- **role** accepts `mentor` / `mentör` (→ MENTOR) and `mentee` / `intern` /
  `stajyer` / `praktikant(in)` (→ MENTEE). Anything else is an error row.
- **status** accepts `active` / `aktif` / `aktiv` (the default when empty) and
  `completed` / `done` / `tamamlandı` / `abgeschlossen`.
- **type** is one of ours (`Meeting`, `Feedback`, `Email`, `Call`, `WhatsApp`)
  or a common word for one: `session`, `görüşme`, `toplantı`, `Treffen`,
  `Gespräch`, `e-mail`, `e-posta`, `phone`, `telefon`, `Anruf`, …
- **Dates** are ISO (`2026-03-01`, `2026-03-01T10:00Z`) or day-first with dots
  (`01.03.2026`). `03/04/2026` is refused rather than guessed, because it means
  two different days on two continents. A date in the future is an error row.

## Column mapping

An incumbent's export will not use our headers. `mapping` names, per sheet, the
source column for each of our fields, for example
`{ people: { email: "E-Mail", role: "Rolle" } }`. A field that is not mapped is
looked up by its own name. Mapping is per-run input and nothing about it is
stored. A required field that is neither mapped nor present in the header is
listed in that sheet's `missing`.

## Stage mapping: explicit, never defaulted

`stageMap` maps each source stage name to one of **this organization's**
pipeline stage keys (its custom stages when it has them, otherwise the default
catalogue). Matching is case- and whitespace-insensitive on the source side.
An exact key of ours (`HIRED_660`) is accepted as-is.

- A source stage nobody mapped makes **that row an ERROR**. It is never mapped
  silently to the start stage: a pair that lands in the wrong stage looks right
  and stays wrong for the rest of the programme.
- A `stageMap` whose target is not a stage of this org refuses the whole request
  (`400 invalid_stage_target`) before anything is planned.

## Stage history is imported as history

- Rows become `StatusChange` records with the **original timestamps**, applied
  per pair in time order.
- A missing `fromStage` becomes the previous row's `toStage`. For the first row
  it is where the pair stood before: the start stage for a new pair, or where
  the existing history began for a re-run.
- **No row from X to X is ever written** (#934). An explicit one is an error
  row; one the chain produces is skipped with that reason.
- A pair's `pipelineStatus` is set from the target of its **last** move. It is
  never taken from a separate column that could disagree.
- `changedById` is NULL ("System"). The move happened in the old system, and
  naming the importing admin would credit them with a decision they did not
  make.

## Rehearsal, then the real run

1. **Rehearse:** send the sheets without `confirm`. That is a dry run, and every
   sheet comes back with what *would* happen per row: CREATE, UPDATE,
   UNCHANGED, SKIP or ERROR, with a reason. The dry run and the real run are
   the same code with a writer that does not write, so the preview is a promise.
2. Fix the export or the mappings and rehearse again until the preview reads
   right.
3. **Apply:** send the same body with `confirm: true`.
4. **Re-running is safe.** People are keyed by e-mail and pairs by both
   e-mails, so a second run reports UNCHANGED. A person already on the platform
   only has empty phone, university or department fields filled in; a
   migration never overwrites what someone typed.

## What a migration never does

- **It sends nothing:** no invitation, no notification, no webhook. Accounts get
  a random password nobody knows. Inviting the migrated people is a separate,
  deliberate step (bulk invite, #2070) once the data looks right. Importing 300
  people must not send 300 e-mails, and the e2e spec asserts that zero are sent.
- **It does not give a mentee two active mentors.** An ACTIVE pair for a mentee
  who already has another active mentor (in the database or earlier in the
  same file) is skipped with that reason. The check is asked again inside the
  write's own transaction (`src/lib/activeMentorship.ts`, #419).
- **It does not reach into another organization.** An address that holds an
  account in another tenant of the same product is reported
  (`belongs to another organization`) and never linked or paired.
- **Only one real run per organization at a time.** It holds a `migration:<org>`
  JobLease; a second real run gets `409 migration_running`. A rehearsal takes
  no lease.

Every created user and relation carries the importing admin's organization
(#678). The activity log records counts only, never the migrated people's data.

## What is deliberately not migrated

Messages, documents and files, evaluations and scorecards, goals and to-dos,
meetings and calendar events, companies, cohorts and placements. None of these
have a sheet. A buyer should hear this before the migration, not after it.
Completed pairs get `completedAt` = the migration moment, which starts the
post-mentorship access window (`POST_MENTORSHIP_ACCESS_MONTHS`) from the
switch-over.

## Limits

At most 5 000 rows per sheet (`413 too_many_rows`) and 1.5 MB of text per
sheet. 20 runs per admin per 10 minutes.
