# Account events from a registered source

An upstream source system (the product a tenant sells, a billing system, a sign-up service) can tell the CRM what happened to one of its accounts: created, trial started, converted, deactivated and so on. The CRM turns a few of those events into funnel moves and records the rest.

This page is the **public contract** (schema version `1`). The implementation is:

| What | Where |
|---|---|
| Route | `src/app/api/integrations/[source]/events/route.ts` |
| Batch route | `src/app/api/integrations/[source]/events/batch/route.ts` |
| Rule (pure, unit-tested) | `src/lib/accountEventRule.ts` · `scripts/test/account-event-rule.test.mjs` |
| Event table (unit-tested) | `planAccountEvent` · `scripts/test/account-event-plan.test.mjs` |
| Envelope validation | `src/lib/accountEventSchema.ts` |
| Writer | `src/lib/accountEventIngest.ts` (new journeys through `src/lib/winBack.ts`, live moves through `src/lib/stageMove.ts`) |
| Source registry | `src/lib/integrationSources.ts` · model `IntegrationSource` |
| Operator CLI | `prisma/register-integration-source.mjs` |
| Historic mode (rule tests) | `scripts/test/account-event-historic.test.mjs` |
| End to end | `e2e/account-event-ingest.spec.ts` · `e2e/account-events-historic.spec.ts` · `e2e/account-events-lost-batch.spec.ts` |

## The endpoint

```
POST /api/integrations/<source>/events
Authorization: Bearer <API key with the companies:write scope>
Content-Type: application/json
```

`<source>` is the **slug** of a source the organization registered (see [Registering a source](#registering-a-source)). The code names no source: the slug is data, looked up inside the API key's organization.

One request carries one event; a replay of many goes to the [batch](#batch) endpoint. The tenant is always the API key's organization, never anything in the request.

## Authentication and the order of the checks

The order is the security model; each step answers before the next one runs.

1. **The API key.** No key, or an unknown, expired or revoked one, is `401`. A key without the `companies:write` scope is `403`. The slug is not looked at before this, so a caller without a key gets the same `401` for every slug and cannot find out which slugs exist. Requests are rate limited per key (the same limiter and numbers as `/api/v1`). A key with a request allowance (a quota) is charged once the key passes this step, so every answer from the later steps counts toward it, a `404` or `403` included.
2. **The source.** The slug is lower-cased and looked up in the key's organization. Not registered, switched off, malformed, reserved, or registered only in *another* organization: all of these are the same `404 { "code": "unknown_source" }`. Nothing is written, and a source an operator switched off answers exactly like one that does not exist, so a sender should park an event answered `404` and retry it later rather than drop it.
3. **The key binding.** A source can be bound to one API key. Any other key of the organization then gets `403 { "code": "wrong_source_key" }`. An unbound source accepts any `companies:write` key of the organization.
4. **The product.** The organization's product must include accounts (the `companies` capability), otherwise `403 { "code": "capability_unavailable" }`.
5. **The envelope**, then the writer.

`companies:write` is not part of the paid public API (`SCOPE_ENTITLEMENT` in `src/lib/apiScopes.ts`): it is the tenant's own data feed. An admin issues the key on `/admin/integrations`; it is never a default scope.

## The envelope

Unknown keys are ignored, so a sender may add fields without breaking anything. A different `schema_version` is refused, so a changed meaning never slips in.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `event_id` | string | yes | The sender's own id for this event: 1–64 characters of `A–Z a–z 0–9 . _ : -`. Opaque to the CRM. Stored lower-cased (see [Idempotency](#idempotency)). |
| `schema_version` | number | yes | Always `1`. |
| `event_type` | string | yes | One of the [event types](#event-types). |
| `occurred_at` | string | yes | ISO 8601 with offset: when it happened at the source. |
| `replay` | boolean \| null | no | `true` marks the event as a replay of the source's own past: it is handled in [historic mode](#historic-mode) whatever its age. Optional; the schema version stays `1`. |
| `external_id` | string | yes | The account's id in the source system: 1–191 characters of printable ASCII (U+0020–U+007E) after trimming, stored lower-cased. Otherwise opaque. It is what `Company.externalId` holds and what every later event is matched on (see [Idempotency](#idempotency) and [Several sources in one organization](#several-sources-in-one-organization)). |
| `trial_started_at` | string \| null | no | ISO 8601. The trial window as the source sends it. |
| `trial_ends_at` | string \| null | no | ISO 8601. |
| `decision_ends_at` | string \| null | no | ISO 8601. Accepted and validated, not stored yet. |
| `acquisition_source` | string \| null | no | The channel the person reported at sign-up: `search_engine`, `social_media`, `youtube`, `referral`, `advertisement` or `other` (the list in `src/lib/leadSourceName.ts`). |
| `referral_code` | string \| null | no | An affiliate or referral code, at most 64 characters. |
| `contact` | object \| null | no | `first_name`, `last_name`, `company_name` (each at most 191 characters) and `email` (a valid address, at most 191). The account's contact name is `first_name` and `last_name` joined, cut to 191 characters. Without `email` a new account gets no funnel record (see [What an event does](#what-an-event-does)). |

No field of the envelope is ever a marketing permission. A new account gets the machine `NONE` contact-permission row and nothing else ([contact-permission.md](../contact-permission.md)).

Example:

```json
{
  "event_id": "evt-2026-10-14-0001",
  "schema_version": 1,
  "event_type": "trial_started",
  "occurred_at": "2026-10-14T09:00:00Z",
  "external_id": "acct-7f3c",
  "trial_started_at": "2026-10-14T09:00:00Z",
  "trial_ends_at": "2026-11-13T09:00:00Z",
  "acquisition_source": "search_engine",
  "referral_code": "PARTNER-12",
  "contact": {
    "first_name": "Ada",
    "last_name": "Lovelace",
    "email": "ada@shop.example",
    "company_name": "Example Shop GmbH"
  }
}
```

## Event types

| `event_type` | What the CRM does |
|---|---|
| `account_created` | Opens a trial: the account's funnel record moves to `TRIAL_ACTIVE` (the account is created if it does not exist yet). |
| `trial_started` | Same as `account_created`. |
| `converted` | The record moves to `DEAL_WON`; on a lost record, a [new journey](#new-journeys) at `DEAL_WON`. An unknown account answers `unknown_account`. |
| `cancelled`, `deactivated` | The record moves to `DEAL_LOST` with a drop-off reason: `CUSTOMER_CANCELLED` when the record had been won (it is at `DEAL_WON`, or its history shows it reached it), otherwise `OTHER` with the fixed note `"<source slug>: ended during trial"`. An unknown account answers `unknown_account`. |
| `reactivated` | On a lost record, a [new journey](#new-journeys): at `DEAL_WON` when the lost record had been won, otherwise a new trial. On any other record it moves nothing (`recorded`). An unknown account answers `unknown_account`. |
| `commitment_confirmed`, `plan_changed`, `cancellation_requested`, `out_of_scope`, `deleted` | Recorded (an `IntegrationEvent` row and an `integration.event` activity entry) and nothing moves. A funnel mapping for any of them is a product decision for a later change. |

Any other value is a `400`.

### The table

What an event does depends on where the account's funnel record is (the active record, else the newest one). `planAccountEvent` in `src/lib/accountEventRule.ts` is the one place this is decided, and `scripts/test/account-event-plan.test.mjs` pins every cell.

| Record is at | `account_created` / `trial_started` | `converted` | `cancelled` / `deactivated` | `reactivated` |
|---|---|---|---|---|
| `LEAD_*`, `TRIAL_ACTIVE` | → `TRIAL_ACTIVE` | → `DEAL_WON` | → `DEAL_LOST` (`OTHER`) | recorded |
| `TRIAL_EXPIRED` | new journey at `TRIAL_ACTIVE` if the event is after the trial's end, else `refused_backward` | → `DEAL_WON` | → `DEAL_LOST` (`OTHER`, or `CUSTOMER_CANCELLED` if it had been won) | recorded |
| `DEAL_WON` | `refused_backward` | applied, nothing to move | → `DEAL_LOST` (`CUSTOMER_CANCELLED`) | recorded |
| `DEAL_LOST` (or any off-path stage) | new journey at `TRIAL_ACTIVE` | new journey at `DEAL_WON` | recorded (already ended) | new journey at `DEAL_WON` if it had been won, else at `TRIAL_ACTIVE` |
| closed (not `ACTIVE`), not lost | new journey at `TRIAL_ACTIVE` | `refused_backward` | recorded (already ended) | recorded |

A target stage the organization does not have is a `conflict` (`"the org has no <stage> stage"`), never a write of an unknown stage key. A drop-off reason the organization's vertical does not know is a `conflict` too: the reason is checked before anything is written.

### New journeys

A record that has ended (lost, or closed) is never reopened, and a trial that has run out is not restarted in place. A new trial, a conversion of a lost customer or a reactivation opens a **new** funnel record for the same lead and owner, chained to the old one by `previousRelationId` (`integration.new_journey`). It goes through the same writer as the person's *win back* button (`winBack()`, `src/lib/winBack.ts`): an old record that is still `ACTIVE` is closed first (`COMPLETED`, lifecycle `ENDED_CHURNED`), the new one starts at the target stage, and if the lead somehow already has another active record nothing is written and the answer is a `conflict`. A trial event dated inside an expired trial's own window belongs to that trial and is refused as a backward move, as before.

### Source fill

Any event that carries `referral_code` or `acquisition_source` fills the lead's `Source` when the lead has none yet: an acquisition source the source system learnt after the account was created still counts. First touch, the import's own rule: a lead that already has a `Source` or a referring person keeps it, and the write is conditional on exactly that.

## What an event does

- **A new account** is created on the organization's default lead owner's funnel, straight into `TRIAL_ACTIVE`. Its name is the contact's company name, else the person's name, else a placeholder `"<source label> <external_id>"` that an operator renames. Its lead `Source` comes from `referral_code` (`affiliate:<code>`), else `acquisition_source` (`channel:<value>`). The event's trial dates replace the CRM's default window. Without a default lead owner the answer is `409 no_default_owner` and nothing is written, so the sender can simply retry once one is set.
- **A funnel record needs a person.** The record's lead is the contact, found or created by `contact.email`. An event with no contact e-mail creates the account **alone**: the answer is `applied` with no `relationId` and a `detail` saying so. Later events for that account answer `recorded` ("the account has no funnel record; nothing moved") until an operator places the account on the funnel; a contact e-mail arriving later is filled into the account's gap but does not create the record by itself.
- **An existing account** (matched on `external_id` inside the organization) only gets gaps filled: an operator's edit is never overwritten. A trial date the record already carries is never overwritten either.
- **Never backwards.** A machine never moves a record to an earlier stage. A refused move is logged (`integration.backward_refused`) and answered `refused_backward`.
- **A closed record is never reopened.** See [New journeys](#new-journeys).
- **Out of order.** An event older than the newest event the same source already applied for the same account is `stale` and changes nothing.
- An external id found on more than one account is a `conflict`; merge the accounts first.

The ingest's own activity entries (`integration.event`, `integration.backward_refused`, `integration.new_journey`) belong to the organization and carry the source's slug in their detail. A [historic](#historic-mode) request writes one `integration.replay` entry instead.

**A live move is a move.** A live (non-historic) stage move goes through the shared stage write path (`recordStageMove`, `src/lib/stageMove.ts`), exactly like a person moving the card: the history row (no actor), a `pipeline.stage_change` activity line, the stage's SLA (`stageDeadline`), the owner's bell and the `pipeline.stage_change` webhook. A live new journey gets the stage's SLA, like the *win back* button's. The lead is never told: a MARKETING organization has no portal, and nothing in this path mails a lead. What a live event can also lead to later is the daily trial sweep's own work on the record it left behind (trial reminders to the owner, the expiry, the decision-window bell), exactly as for a record a person created. A **historic** event stays silent (below).

## Historic mode

A source that connects after years of its own history replays that history through this same endpoint, oldest first. Those events describe the past, and the CRM writes them as the past, without telling anybody about them.

An event is **historic** when either

- the envelope says `"replay": true`, or
- `occurred_at` is more than **3 days** before the moment the CRM receives it (`HISTORIC_EVENT_AGE_DAYS` in `src/lib/accountEventRule.ts`). A live feed delivers within minutes; one that parked a `404` for a day or two is still live.

A live event (neither) is handled exactly as described above. A historic one goes through the same checks (claim, duplicates, out-of-order, never backwards, new journeys) and differs in these ways only:

| | Historic |
|---|---|
| **Dates** | Everything it writes is dated at `occurred_at` (never later than the moment it arrives): a new account's and its lead's creation time, the funnel record's start, a stage move's history row, the end of a closed record a new journey replaces. The trial window comes from `trial_started_at` / `trial_ends_at`; without them the organization's trial length is counted from `occurred_at`. |
| **A trial that already ran out** | A record placed in `TRIAL_ACTIVE` whose trial's last day is before today (UTC, the same rule as the daily expiry) moves straight on to `TRIAL_EXPIRED`, with a history row dated at the trial's end (strictly after the move into the trial, even when a source sends an end at or before its start). |
| **A conversion during the trial** | The expiry above is decided when the trial's own event arrives, before the replay says what came next. When a later historic event moves the record on at a moment *before* that expiry (a customer who paid during the trial), the expiry is taken back: its history row is removed and the move is written from `TRIAL_ACTIVE`. Only the system's own expiry, and only while it is the record's newest history row (`shouldUndoHistoricExpiry`). |
| **History already on the record** | The out-of-order guard only knows the source's own events. A historic move into a record that already has newer history (a person's move from today, an import's) is dated right after that newest row instead of underneath it, and never before the record's start (`historicMoveAt`), so every "last move" reader (the stage clock, the board, the timeline) still sees the newest move last. |
| **Decision window** | When the expired trial's decision window (`trial_ends_at` + the organization's `decisionWindowDays`) has already closed, its one reminder is claimed up front, so the daily sweep never rings about it. A window still open is left alone: that reminder is real, upcoming work. |
| **Trial reminders** | None for the past: a trial that ended is expired, not warned about. A trial that is still running today is a running trial, and its owner's 7/3/0-day reminders come as usual. |
| **Activity log** | One `integration.replay` entry per request (the counts of what the request did) instead of one entry per event and per new account. |
| **Losses and new journeys** | A historic loss is a backdated history row carrying its drop-off reason; a historic new journey closes the old record and starts the new one at the event, with no stage deadline. |
| **Response** | The `200` body carries `"historic": true`. |

Nothing in historic mode mails a lead or a customer, and nothing writes a stage SLA, a webhook delivery, a `pipeline.stage_change` activity line or a notification.

## Batch

```
POST /api/integrations/<source>/events/batch
Authorization: Bearer <API key with the companies:write scope>
Content-Type: application/json

{ "events": [ <envelope>, … ], "dry_run": false }
```

For a replay of a source's history. The door is the single route's, in the same order ([Authentication](#authentication-and-the-order-of-the-checks)): `401`, `403`, the same `404 unknown_source`, `403 wrong_source_key`, `403 capability_unavailable`. The rate limit and a key's quota are charged **once per batch**.

- **At most 200 events** (`ACCOUNT_EVENT_BATCH_MAX`); more is `400 { "code": "too_many_events" }`, none is a `400`.
- **All or nothing at the envelope.** Every event is validated first; one invalid event refuses the whole batch with a `400` whose issue paths name it (`events.3.external_id`), and nothing is handled.
- **Sorted on the server.** The events are processed one after another by `external_id`, then `occurred_at`, then their position in the request: the order a replay must be applied in, whatever order they were listed in.
- **Always historic.** Every event of a batch is handled in [historic mode](#historic-mode), as if it carried `replay: true`. The request writes one `integration.replay` activity line.
- **One event, one ordinary ingest.** Each event is exactly what the single route would do with it: its own claim, its own transactions, the same outcomes. A batch that fails with a server error midway can be resent whole: the events it already handled answer `duplicate`.
- **The answer** is `200 { "dry_run": false, "results": [ … ] }` with one result per event **in the request's order**: `{ "index", "event_id", "outcome", "companyId"?, "relationId"?, "detail"?, "historic": true }`, with the single route's outcome vocabulary. `no_default_owner` is one of the outcomes here, not a `409` for the batch.

### Dry run

`"dry_run": true` runs the **same** batch through the same code, inside one database transaction that is rolled back at the end: a writer that does not write. Every event sees what the earlier events of the run did, so a `converted` after an `account_created` of the same batch is judged exactly as the real run would judge it, and the outcomes are the real run's. Nothing persists: no account, lead, record, history row, claim, source, permission, reminder claim, activity line or notification, and nothing is rung, mailed or delivered.

Its limits:

- The answer carries no `companyId` / `relationId`: those rows were removed by the rollback.
- It answers for the database as it is **at that moment**. A live event arriving between the dry run and the real run can change an outcome.
- It holds the row locks a real run would take for as long as it runs (at most two minutes, `DRY_RUN_TIMEOUT_MS`), so a live event for an account in the batch waits for it. Dry-run before switching a live feed on, not during peak traffic.

## Idempotency

Each event is claimed **once** per organization and source: `(organization, source slug, event_id)` is a unique key. A repeated `event_id` answers `200` with `"outcome": "duplicate"` and writes nothing.

Ids are **case-insensitive**. `event_id` and `external_id` are stored lower-cased, and the database column collation compares them without regard to case anyway, so `EVT-1` and `evt-1` are the same event and `ACCT-7F3C` and `acct-7f3c` the same account. A sender whose ids differ only by case must not use this feed as is.

Ids are **ASCII only**. The same collation also ignores accents (`café` equals `cafe`, `straße` equals `strasse`), so a non-ASCII id could match a different account. `event_id` has always been ASCII; `external_id` is refused with a `400` unless it is printable ASCII, so letter case is the only folding left and the CRM applies it itself.

A claim whose processing crashed is taken over after ten minutes, and a request that fails with a server error releases its claim, so retrying is always safe.

## Responses

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ "outcome": "applied" \| "duplicate" \| "stale" \| "refused_backward" \| "recorded" \| "unknown_account" \| "conflict", "companyId"?, "relationId"?, "detail"?, "historic"? }` | The event was handled (`historic: true` when in [historic mode](#historic-mode)). Only `applied` changed an account or the funnel: a new account, a funnel move, or both (an `applied` without `relationId` is an account created without a funnel record). |
| `400` | `{ "error": "Invalid event", "issues": [{ "path", "message" }] }` | The envelope is invalid. Do not retry unchanged. (Batch: also `{ "code": "too_many_events" }`.) |
| `401` | `{ "error": … }` | No usable API key. |
| `403` | `{ "error": … }`, `{ "code": "wrong_source_key" }`, `{ "code": "capability_unavailable" }` | Wrong scope, wrong key for this source, or the product has no accounts. |
| `404` | `{ "code": "unknown_source" }` | No such source for this organization, or it is switched off. Nothing was written; park the event and retry later rather than dropping it. |
| `409` | `{ "code": "no_default_owner" }` | Retry once the organization has a default lead owner. |
| `429` | `{ "type": "rate_limited" \| "quota_exceeded" }` | Back off; `Retry-After` says how long. |

## Registering a source

A source is one `IntegrationSource` row: `orgId`, `slug`, `label`, `enabled`, and an optional `apiKeyId` binding.

- **slug**: 2–40 characters of `a–z`, `0–9` and `-`, starting with a letter or digit. It is the URL segment and the key every stored event is filed under, so it is **immutable**: a new name means registering a new source. The names of the other routes under `/api/integrations/` (`calendar`, `google`) are reserved.
- **label**: up to 80 characters; shown to operators and used in placeholder account names.
- **enabled**: a disabled source answers `404`, exactly like an unregistered one. Switching a source off therefore pauses it only for senders that retry a `404`; a sender that drops on `404` loses the events posted meanwhile.
- **apiKeyId**: optional; when set, only that `companies:write` key may post for the source.

The operator registers a source with the CLI. It is a dry run unless `--apply` is given:

```bash
node prisma/register-integration-source.mjs --org <org slug or id> --slug <slug> --label "<label>"            # dry run
node prisma/register-integration-source.mjs --org <org slug or id> --slug <slug> --label "<label>" --apply    # write
node prisma/register-integration-source.mjs --org <org> --slug <slug> --key <apiKeyId> --apply   # bind to one key
node prisma/register-integration-source.mjs --org <org> --slug <slug> --unbind-key --apply       # any companies:write key
node prisma/register-integration-source.mjs --org <org> --slug <slug> --disable --apply          # switch off
node prisma/register-integration-source.mjs --list [--org <org>]
```

Every run says whether the source is on: `--disable` switches it off and a run without it switches it back on. The CLI refuses a malformed or reserved slug, an unknown organization, and a `--key` that is not a live `companies:write` key of that organization. It warns, and still writes, when the organization is not a MARKETING tenant (the writer creates marketing accounts and funnel records) and when the organization already has another enabled source (see below).

The demo seed registers a `demo-feed` source in the demo marketing tenant, so a preview environment can exercise the route once an admin has issued a `companies:write` key and set a default lead owner.

## Several sources in one organization

An organization may register more than one source, but all of them share **one account namespace**. `external_id` is matched against `Company.externalId` inside the organization, whichever source sent the event. Two sources that both use `1001` for *different* accounts act on one account: a `converted` from one moves the funnel record the other one opened.

So the sources of one organization must either use the same id for the same account (a sign-up service and a billing system of the same product, say) or ids that can never collide, for example a per-source prefix (`billing:1001`).

What stays per source is the bookkeeping: the duplicate claim is keyed on `(organization, source slug, event_id)`, so two sources may reuse each other's event ids, and the out-of-order check compares an event only with the events of its own source.

## Pull instead of push

The writer does not care how an event arrived. A later pull job that reads events from a source's own endpoint calls the same `ingestAccountEvent(orgId, source, event)` and resolves the source through the same registry; its connection settings would become further nullable columns on `IntegrationSource`.
