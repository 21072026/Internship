# Account events from a registered source

An upstream source system (the product a tenant sells, a billing system, a sign-up service) can tell the CRM what happened to one of its accounts: created, trial started, converted, deactivated and so on. The CRM turns a few of those events into funnel moves and records the rest.

This page is the **public contract** (schema version `1`). The implementation is:

| What | Where |
|---|---|
| Route | `src/app/api/integrations/[source]/events/route.ts` |
| Rule (pure, unit-tested) | `src/lib/accountEventRule.ts` · `scripts/test/account-event-rule.test.mjs` |
| Envelope validation | `src/lib/accountEventSchema.ts` |
| Writer | `src/lib/accountEventIngest.ts` |
| Source registry | `src/lib/integrationSources.ts` · model `IntegrationSource` |
| Operator CLI | `prisma/register-integration-source.mjs` |
| Rollback CLI | `prisma/wipe-integration-source.mjs` · `scripts/test/marketing-ops-clis.test.mjs` |
| Historic mode (rule tests) | `scripts/test/account-event-historic.test.mjs` |
| End to end | `e2e/account-event-ingest.spec.ts` · `e2e/account-events-historic.spec.ts` · `e2e/marketing-ops-clis.spec.ts` (rollback) |

## The endpoint

```
POST /api/integrations/<source>/events
Authorization: Bearer <API key with the companies:write scope>
Content-Type: application/json
```

`<source>` is the **slug** of a source the organization registered (see [Registering a source](#registering-a-source)). The code names no source: the slug is data, looked up inside the API key's organization.

One request carries one event. The tenant is always the API key's organization, never anything in the request.

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
| `converted` | The record moves to `DEAL_WON`. An unknown account answers `unknown_account`. |
| `commitment_confirmed`, `plan_changed`, `deactivated`, `cancellation_requested`, `cancelled`, `reactivated`, `out_of_scope`, `deleted` | Recorded (an `IntegrationEvent` row and an `integration.event` activity entry) and nothing moves. A funnel mapping for any of them is a product decision for a later change. |

Any other value is a `400`.

## What an event does

- **A new account** is created on the organization's default lead owner's funnel, straight into `TRIAL_ACTIVE`. Its name is the contact's company name, else the person's name, else a placeholder `"<source label> <external_id>"` that an operator renames. Its lead `Source` comes from `referral_code` (`affiliate:<code>`), else `acquisition_source` (`channel:<value>`). The event's trial dates replace the CRM's default window. Without a default lead owner the answer is `409 no_default_owner` and nothing is written, so the sender can simply retry once one is set.
- **A funnel record needs a person.** The record's lead is the contact, found or created by `contact.email`. An event with no contact e-mail creates the account **alone**: the answer is `applied` with no `relationId` and a `detail` saying so. Later events for that account answer `recorded` ("the account has no funnel record; nothing moved") until an operator places the account on the funnel; a contact e-mail arriving later is filled into the account's gap but does not create the record by itself.
- **An existing account** (matched on `external_id` inside the organization) only gets gaps filled: an operator's edit is never overwritten. A trial date the record already carries is never overwritten either.
- **Never backwards.** A machine never moves a record to an earlier stage. A refused move is logged (`integration.backward_refused`) and answered `refused_backward`.
- **A closed record is never reopened.** A new trial for a lost or completed account opens a **new** funnel record chained to the old one (`integration.new_journey`).
- **Out of order.** An event older than the newest event the same source already applied for the same account is `stale` and changes nothing.
- An external id found on more than one account is a `conflict`; merge the accounts first.

The ingest's own activity entries (`integration.event`, `integration.backward_refused`, `integration.new_journey`) belong to the organization and carry the source's slug in their detail. A [historic](#historic-mode) request writes one `integration.replay` entry instead.

**Quiet, always.** The feed is a machine, not a person moving a card: it sets no stage SLA (`stageDeadline`), fires no `pipeline.stage_change` webhook, rings no bell and sends no mail, live or historic. What a live event *can* lead to later is the daily trial sweep's own work on the record it left behind (trial reminders to the owner, the expiry, the decision-window bell), exactly as for a record a person created.

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
| **Response** | The `200` body carries `"historic": true`. |

Nothing in historic mode mails a lead or a customer, and nothing writes a stage SLA, a webhook delivery or a notification (see *Quiet, always* above).

## Idempotency

Each event is claimed **once** per organization and source: `(organization, source slug, event_id)` is a unique key. A repeated `event_id` answers `200` with `"outcome": "duplicate"` and writes nothing.

Ids are **case-insensitive**. `event_id` and `external_id` are stored lower-cased, and the database column collation compares them without regard to case anyway, so `EVT-1` and `evt-1` are the same event and `ACCT-7F3C` and `acct-7f3c` the same account. A sender whose ids differ only by case must not use this feed as is.

Ids are **ASCII only**. The same collation also ignores accents (`café` equals `cafe`, `straße` equals `strasse`), so a non-ASCII id could match a different account. `event_id` has always been ASCII; `external_id` is refused with a `400` unless it is printable ASCII, so letter case is the only folding left and the CRM applies it itself.

A claim whose processing crashed is taken over after ten minutes, and a request that fails with a server error releases its claim, so retrying is always safe.

## Responses

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ "outcome": "applied" \| "duplicate" \| "stale" \| "refused_backward" \| "recorded" \| "unknown_account" \| "conflict", "companyId"?, "relationId"?, "detail"?, "historic"? }` | The event was handled (`historic: true` when in [historic mode](#historic-mode)). Only `applied` changed an account or the funnel: a new account, a funnel move, or both (an `applied` without `relationId` is an account created without a funnel record). |
| `400` | `{ "error": "Invalid event", "issues": [{ "path", "message" }] }` | The envelope is invalid. Do not retry unchanged. |
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

## Rolling a source back

When a replay went wrong (the wrong organization, the wrong id space, a test run against production), the operator removes what one source created in one organization and replays it:

```bash
node prisma/wipe-integration-source.mjs --org <org slug or id> --source <slug>            # dry run: counts per table
node prisma/wipe-integration-source.mjs --org <org slug or id> --source <slug> --apply    # delete
```

**What the source created** is exactly the accounts whose `Company.createdBySource` is the slug. The writer stamps it in the same insert that creates the account, and only there: an account a person typed in, a demo request converted to an account, a file import, and an account a feed only *matched* all leave it empty. It was added with this tool, so accounts ingested before it existed are not found (they show up as "moved but did not create").

For each such account, in one transaction, the tool deletes its funnel records and their stage history, its lead stand-ins (a lead record created with the account that has no funnel record elsewhere), the activity entries about the account, its records and its stand-ins, this source's events for it, and the account itself (its machine-written contact-permission row and channels go with it).

It **keeps** an account a person has worked on and names the reason. The test is open-ended, so a table added later is protected by default:

- a row in **any** table with a foreign key to one of its records or to the account — interactions, notes, messages, meetings, offers, goals, evaluations, contact persons, entitlements, a converted inquiry, … — except the few tables only machines write (`MACHINE_TABLES` in the script, each with its reason);
- any activity entry a person is the actor of about the account, its records or its stand-ins (a win-back, a trial or contract-end change, an account edit, a channel added); reading an account is not work;
- a stage move a person made, a deal value a person typed (any `RelationValue` not from an import), or a channel changed after the account was created;
- contact-permission evidence: a basis other than `NONE`, a confirmation, an admin grant or a withdrawal. The owner's withdrawal locks the row against every later write ([contact-permission.md](../contact-permission.md)); a re-created account would start from `NONE` without it;
- another user attached to the account, or a lead that is not one of its own stand-ins (a person, or a record the feed re-pointed — the writer moved its company link and may have overwritten its name and phone, and deleting the record would undo neither).

The verdict is read again inside each account's transaction, so work added while a long run is going keeps that account (it is reported as failed, with the reason).

Outside the accounts it deletes the source's events that name no surviving account (recorded, stale, unknown account) and its `integration.*` activity entries about such an external id. Everything the source did to an account that **stays** — a kept one, or one it only **moved** — stays as evidence: its events, its activity entries, and any record the source opened on it (`integration.new_journey`). Those accounts are left exactly as they are, stage and history included; the dry run lists them, and the records opened on them, so an operator can look. Because their events stay, a replay skips those event ids as duplicates instead of moving the accounts a second time. Nothing of another source or another organization is touched, and the registered source, the lead `Source` rows and the settings stay. `--json` prints the plan and, with `--apply`, what was deleted per table; the dry run and the apply count the same rows.

## Pull instead of push

The writer does not care how an event arrived. A later pull job that reads events from a source's own endpoint calls the same `ingestAccountEvent(orgId, source, event)` and resolves the source through the same registry; its connection settings would become further nullable columns on `IntegrationSource`.
