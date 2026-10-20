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
