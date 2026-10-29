# Stage automation rules

Story #1689 (epic #1682). The engine is #1703; the admin builder, dry run and run
log are #1704.

> **When a relation enters (or leaves) stage X, and these conditions hold, run these
> actions in this order — optionally after a delay.**

## One vocabulary: `src/lib/automation/rule.ts`

Pure and client-safe (zod only). It holds:

- **Triggers** — `STAGE_ENTRY` | `STAGE_EXIT`, on one stage key (the tenant's own
  stages, custom ones included).
- **Conditions** — an allowlisted *field → operator → value* row, AND-ed:
  `kind` (eq/neq `PLACEMENT|COACHING`), `hasCompany` (eq boolean), `fromStage` /
  `toStage` (in/notIn a list of stage keys), `daysInFromStage` (gte/lte whole days).
  The facts are computed by the server from the relation and the event, never read
  from a request. `evaluateConditions()` is the **one** evaluator — the live run and
  the dry run (#1704) call the same function.
- **The action allowlist** (`AUTOMATION_ACTIONS`), each with a strict zod parameter
  schema:

  | action | parameters | what it does |
  |---|---|---|
  | `notifyRole` | `role`: mentor · mentee · company · admins | in-app notification through `notifyIfAllowed()` |
  | `sendTemplateEmail` | `template`: `menteeNextStep` · `mentorCheckIn` | a catalogued mail through `sendEmail()` (`stage-update`, pipeline_updates) |
  | `setStageDeadline` | `days` 1–365 | `stageDeadline` = now + days, re-arms the reminder |
  | `assignGoalFromTemplate` | `templateId` (org's `ProjectTaskTemplate`) | one PAIR `Goal`, worded in the mentee's language |
  | `requireDocument` | `requirementId` (org's active `DocumentRequirement`) | tells the mentee to upload it, unless already satisfied |
  | `addTag` | `tagId` (org's `Tag`) | labels the mentee (max 20 tags, idempotent) |

- **`parseRuleInput()`** — THE write-time gate. An unknown action, an unknown
  condition field, an extra key (`url`, `to`, `body`, …) is **rejected when the rule is
  stored**, not skipped when it runs. A rule that would message the mentee on entry to
  an outcome stage is refused (`mentee_message_on_outcome_stage`).

### The safety line

- **No action takes a URL, a free-form recipient address or text that is evaluated or
  rendered.** Recipients are roles relative to the relation; mail copy is one of the
  catalogued templates in `notifications.automationEmail` (EN/TR/DE); every id a rule
  names is checked against the rule's org at write time *and* at run time.
- **No action moves a stage** (`movesStage: false`, pinned by the unit spec). A rule
  therefore cannot raise another `pipeline.stage_change` — it cannot retrigger itself
  or start a chain; the chain depth is structurally 0.
- **Free core**: no action restricts a mentor's or a mentee's messaging, meetings,
  goals, portal or pipeline access.
- **`logInteraction` is deliberately not an action**: an `InteractionLog` row *is*
  contact (`docs/last-contact.md`), so an automated one would silence the stagnation
  reminder about a mentee nobody spoke to.
- **Outcome stages**: on an ending stage the mentee hears from their mentor
  (`outcomeComms.ts`, #830). A mentee-facing action on a run whose relation sits on an
  outcome stage is recorded `skipped: outcome_stage`; the mentor/admin ones still run.

## Two models

- **`AutomationRule`** — `orgId`, `programId` (reserved for #1618), `name`, `trigger`,
  `stageKey`, `conditions` (JSON), `actions` (JSON, ordered), `delayMinutes`,
  `enabled` (default **off**), `position`, `lastSimulatedAt`, `createdById`.
- **`AutomationRun`** — one per (rule, event): `eventId`, `relationId`, `fromStage`,
  `toStage`, `status`, `results` (per action: index, type, `ok|skipped|failed`, a
  code), `error`, `runAt`, `finishedAt`. **Unique on `(ruleId, eventId)`.**

Both are in `TENANT_MODELS`. `AutomationRun.error` is operational text (erasure
coverage: OPS).

## The engine: `src/lib/automation/engine.ts`

Storage is injected (`AutomationStore`); `evaluate.ts` binds it to Prisma, the unit
spec to memory.

1. **`evaluateStageEvent()`** — the body of the `automation` subscriber on
   `pipeline.stage_change` (`src/lib/events/subscribers/automation.ts`, which imports
   the evaluator lazily). It runs in an `event.deliver` job, **never in the request
   that moved the stage**: a bulk advance of N relations is N events, N jobs, N runs.
   It loads the org's **enabled** rules for the move's two stages (by `orgId`, inside
   `runWithOrg`), re-checks every rule and the relation against the event's org,
   judges the conditions and writes one run: `SKIPPED` (`conditions_not_met: …`),
   `FAILED` (`invalid_rule` — stored JSON that no longer parses) or `PENDING`.
2. **`executeRun()`** claims a PENDING run (`PENDING → RUNNING`, one guarded
   `updateMany`) and executes its actions in order. No delay: right away, in the same
   job. A delay: the `automation.run` job (`runAt` = move + delay, key
   `automation:<runId>`), which re-checks that the rule is still enabled
   (`rule_disabled`) and, for an entry rule, that the relation is still in the stage
   (`left_stage`).

- **Re-entrancy**: a redelivered event finds its run by `(ruleId, eventId)` and does
  nothing.
- **At-most-once actions**: a container killed mid-run leaves the row `RUNNING` (visible
  in the run log) rather than mailing someone twice.
- **Failure**: a throwing action is recorded `failed` with its message, the next action
  still runs, the run ends `PARTIAL` or `FAILED`. The stage move is never touched — it
  committed before the event existed.

## Scope boundary (#1684)

This is the **only** stage-triggered rule engine. Audience messaging — segments,
per-person caps, cooldown, the dormancy-mail limits — is the nudge engine's
(`NudgeRule`/`NudgeSend`, #1684/#1686), which does not subscribe to
`pipeline.stage_change`. The messaging actions here use the product's single send
paths and therefore the same unsubscribe check; there is no second opt-out check and
no second segment vocabulary.

## The admin API (#1704)

Every route checks `requirePermission('org.settings.write')` **in the handler** (an
org admin), takes the org from the session and answers **404** for another org's rule.
All of `/api/admin/automations*` is on the demo write blocklist.

| route | |
|---|---|
| `GET /api/admin/automations` | rules (display order), the org's stages (`resolvePipelineStages`, custom ones included, with `isOutcome`), the pickers' tags / document requirements / goal templates |
| `POST /api/admin/automations` | create — `validateRuleForOrg()` (allowlist + stage is the org's + every named row is the org's); always stored **disabled** |
| `PATCH /api/admin/automations/[id]` | any subset, re-validated whole. Changing what the rule does clears `lastSimulatedAt`; switching it **on** without a dry run since → `409 simulate_first` |
| `DELETE /api/admin/automations/[id]` | the rule and its runs |
| `POST /api/admin/automations/reorder` | `{ ids }` — display order only; the engine runs every matching rule |
| `POST /api/admin/automations/[id]/simulate` | the dry run (below); `{ draft }` judges unsaved edits without stamping |
| `GET /api/admin/automations/runs` | the run log, newest first, `?ruleId=`, keyset `?before=` |

### The dry run: `src/lib/automation/simulate.ts`

Replays the rule against the org's last N (default 200, max 500) real `StatusChange`
rows: trigger match, conditions (`daysInFromStage` from the relation's own recorded
stage entries), and the outcome-stage skip — the live engine's verdicts on the same
inputs. **It executes nothing by construction**: `simulate.ts` imports `./rule` and
nothing else, and the route's module graph never reaches the engine, an action
handler, `notify` or a mailer (`e2e/automation-builder.unit.spec.ts` pins the import
lists). The only write is the rule's `lastSimulatedAt`.

## The screen: `/admin/automations` (#1704)

AdminNav entry `automations` (capability `pipeline`, so every vertical with a board
has it; a native-app icon in `apps/mobile/src/lib/menu.ts`). Two tabs:

- **Rules** (`automation-rule-list`): name, trigger summary, steps, On/Off, the last
  dry run. A rule that has not been dry-run since its last logic change shows the
  warning and its switch stays disabled (the server answers `409 simulate_first`
  anyway). Edit opens the editor (`automation-editor`): trigger, the org's stages,
  delay, condition rows and an ordered step list with a typed control and one help
  line per action. Reorder (up/down), delete with confirmation.
- **Dry run** (`automation-simulate-output`): the summary and, per matched move, fire
  or skip with the failed conditions, and each step as *would run* / *skipped —
  outcome stage*.
- **Run log** (`automation-run-log`): status, per-step result and code, error text.

**`src/components/automation/ConditionRow.tsx`** is the shared *field → operator →
value* row. It knows neither engine: the audience-nudge builder (#1686) imports it
instead of shipping a second one.

`e2e/automation-builder.spec.ts` drives create → dry run (zero runs, zero
notifications) → switch on → a real stage move → the worker runs the rule → the run
log, plus the cross-org 404s and a refused unknown action.

## Retention

The `automationRun` entry of the retention registry (`src/lib/retentionEntries.ts`):
90 days, no setting, the same window as the `DomainEvent` a run points at. PENDING and
RUNNING runs are never pruned.
