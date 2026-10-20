# Program journey (#1852)

"What happens in week 6" as data. A programme (the `Cohort` row, which #1622
renames to `Program` behind `@@map("Cohort")`) carries ordered **steps**; a
daily sweep turns the steps that fall due into in-app nudges, to-dos, content
and agenda suggestions for each active pair of the programme — once.

## Model

| | |
|---|---|
| `ProgramStep` | `programId`, `orgId`, `order`, `anchor`, `offsetDays`, `audience`, `action`, `payload`, `title` + `translations`, `publishedAt`, `archivedAt`. In `TENANT_MODELS`. |
| `ProgramStepRun` | `stepId`, `relationId`, `dueAt`, `deliveredAt`, `skippedReason`. `@@unique([stepId, relationId])`. Reached through its step — no `orgId`, deliberately unregistered. |

Vocabularies (free Strings in the schema, whitelists in `src/lib/programJourneyRule.ts`):

- **anchor** — `RELATION_START` · `PROGRAM_START` (unresolved until #1622 gives the programme a start date) · `STAGE_ENTRY` (`payload.stageKey`, the first time the relation entered that stage).
- **audience** — `MENTOR` · `MENTEE` · `BOTH`.
- **action** — `NUDGE` · `ASSIGN_TODO` (adds a `Goal` to the pair, worded in the mentee's language) · `PUBLISH_CONTENT` (`payload.url`: a same-app path or credential-free https) · `SUGGEST_AGENDA` · `GROUP_SESSION`.
- **payload.skipIf** — `meeting_exists` · `goal_exists` · `message_exists` · `interaction_logged`.

## Rules

1. **The claim is the unique.** The run row is inserted before anything is delivered; a second sweep (same day, other replica) loses with P2002. Delivery is at-most-once: a row with neither `deliveredAt` nor `skippedReason` means "claimed, not confirmed", never "send again".
2. **No backfill.** Only pairs whose anchor + offset lands within the last `JOURNEY_LOOKBACK_DAYS` (7) are queried. Publishing a journey on a live programme leaves no rows for the steps already behind its pairs.
3. **The tenant's own stages.** A `STAGE_ENTRY` step whose key the org's resolved pipeline lacks is returned in `unresolved` with `stage_not_in_pipeline` and logged — never matched against the built-in set.
4. **Satisfied steps are recorded, not sent** (`skippedReason = "satisfied:<condition>"`).
5. **Bounded.** `JOURNEY_BATCH` (200) deliveries per tick; the rest are still inside the window tomorrow.
6. **In-app only, through `notifyIfAllowed`** under the recipient's `mentorship` preference. No mail and no condition evaluation: the automation engine (#1703) owns acting on rules.

## Running it

Daily at 07:10 UTC from `/api/cron/start` (`initProgramJourneyCron`). An admin can run it
for their own org with `GET /api/cron?job=program-journey` (`?at=<ISO>` pins the clock).
`runProgramJourney()` is a plain handler, so the durable scheduler (#1676/#1677) registers
it in one line. Replica ≥2 runs with `CRON_ENABLED=0` today; the unique claim makes a
double tick harmless regardless.

## The builder (#1853)

`/admin/programs/[id]/journey` — linked from every row of `/admin/cohorts` until #1628
gives programmes their own index. Steps are listed in `order`, grouped under consecutive
`milestone` labels (a label, not a row, so a journey stays one flat list), edited in
EN/TR/DE, reordered with up/down, published one by one or all at once, archived (never
deleted — the runs they produced stay readable).

- **API** (`src/lib/programJourneyAdmin.ts` authorizes every verb: ADMIN of the
  programme's own tenant, `mentorship` capability; another tenant's programme is 404):
  `GET|POST|PATCH /api/admin/programs/[id]/journey` (`PATCH { order }` / `{ publish: 'all' }`),
  `PATCH|DELETE …/journey/[stepId]` (`{ published }`, `{ archived }`, any field).
- **Refused on write**, through the same `stepUnresolvable()` the sweep reads: a stage key
  the org's pipeline lacks, `PROGRAM_START` until #1622, an unsafe content link, no title.
- **Preview** — `GET …/journey/preview?relationId=` → `journeyStepStatus()` per step
  (`due`, `would_skip`, `upcoming`, `missed`, `waiting`, `delivered`, …). It never writes a
  `ProgramStepRun`; `e2e/program-journey-builder.spec.ts` counts the rows around it.
- **Template** — `GET …/journey` returns `template: journeyTemplate(steps)`: no ids, no
  dates, no tenant, so a clone (#1641/#1643) is a data copy.
- **Unpublish** clears `publishedAt`: the sweep stops picking the step; runs already
  recorded are untouched.

## The participant view (#1855)

`GET /api/journey?relationId=` → `JourneyView` (`src/components/JourneyView.tsx`), mounted
on `/portal/journey` and `/mentor/mentees/[id]` (above the relation timeline, which is the
backward-looking record — the journey does not repeat it).

- **One list for the pair.** The onboarding checklist (`loadOnboardingState()`) is its first
  milestone ("Getting started"); the programme's steps follow. Both seats get the same rows
  and the same dates.
- **Groups** come from `participantGroup()`: `due` → now; `upcoming`/`waiting` → next;
  `delivered`/`skipped`/`would_skip`/`claimed` → done. Drafts, archived, `missed` and
  `unresolved` steps are not shown to the pair.
- **Evidence, not a nag.** A satisfied step carries `{ condition, at }` from
  `satisfactionEvidence()` — when the meeting, goal, message or interaction first happened.
- **Authorization** by relation membership: the mentor, the mentee, or an ADMIN of the
  relation's tenant. Another relation of the tenant is 403; another tenant's is 404.
