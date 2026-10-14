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
| End to end | `e2e/account-event-ingest.spec.ts` |

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

1. **The API key.** No key, or an unknown, expired or revoked one, is `401`. A key without the `companies:write` scope is `403`. The slug is not looked at before this, so a caller without a key gets the same `401` for every slug and cannot find out which slugs exist. Requests are rate limited per key (the same limiter and numbers as `/api/v1`).
2. **The source.** The slug is lower-cased and looked up in the key's organization. Not registered, switched off, malformed, reserved, or registered only in *another* organization: all of these are the same `404 { "code": "unknown_source" }`.
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
| `external_id` | string | yes | The account's id in the source system. Opaque: trimmed, lower-cased, 1–191 characters, no control characters. It is what `Company.externalId` holds and what every later event is matched on. |
| `trial_started_at` | string \| null | no | ISO 8601. The trial window as the source computed it. |
| `trial_ends_at` | string \| null | no | ISO 8601. |
| `decision_ends_at` | string \| null | no | ISO 8601. Accepted and validated, not stored yet. |
| `acquisition_source` | string \| null | no | The channel the person reported at sign-up: `search_engine`, `social_media`, `youtube`, `referral`, `advertisement` or `other` (the list in `src/lib/leadSourceName.ts`). |
| `referral_code` | string \| null | no | An affiliate or referral code, at most 64 characters. |
| `contact` | object \| null | no | `first_name`, `last_name`, `company_name` (each at most 191 characters) and `email` (a valid address, at most 191). |

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

- **A new account** is created on the organization's default lead owner's funnel, straight into `TRIAL_ACTIVE`. Its name is the contact's company name, else the person's name, else a placeholder `"<source label> <external_id>"` that an operator renames. Its lead `Source` comes from `referral_code` (`affiliate:<code>`), else `acquisition_source` (`channel:<value>`). The source's trial dates replace the CRM's default window. Without a default lead owner the answer is `409 no_default_owner` and nothing is written, so the sender can simply retry once one is set.
- **An existing account** (matched on `external_id` inside the organization) only gets gaps filled: an operator's edit is never overwritten. A trial date the record already carries is never overwritten either.
- **Never backwards.** A machine never moves a record to an earlier stage. A refused move is logged (`integration.backward_refused`) and answered `refused_backward`.
- **A closed record is never reopened.** A new trial for a lost or completed account opens a **new** funnel record chained to the old one (`integration.new_journey`).
- **Out of order.** An event older than the newest event already applied for the same account is `stale` and changes nothing.
- An external id found on more than one account is a `conflict`; merge the accounts first.

The ingest's own activity entries (`integration.event`, `integration.backward_refused`, `integration.new_journey`) belong to the organization and carry the source's slug in their detail.

## Idempotency

Each event is claimed **once** per organization and source: `(organization, source slug, event_id)` is a unique key. A repeated `event_id` answers `200` with `"outcome": "duplicate"` and writes nothing.

Ids are **case-insensitive**. `event_id` and `external_id` are stored lower-cased, and the database column collation compares them without regard to case anyway, so `EVT-1` and `evt-1` are the same event and `ACCT-7F3C` and `acct-7f3c` the same account. A sender whose ids differ only by case must not use this feed as is.

A claim whose processing crashed is taken over after ten minutes, and a request that fails with a server error releases its claim, so retrying is always safe.

## Responses

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ "outcome": "applied" \| "duplicate" \| "stale" \| "refused_backward" \| "recorded" \| "unknown_account" \| "conflict", "companyId"?, "relationId"?, "detail"? }` | The event was handled. Only `applied` changed the funnel. |
| `400` | `{ "error": "Invalid event", "issues": [{ "path", "message" }] }` | The envelope is invalid. Do not retry unchanged. |
| `401` | `{ "error": … }` | No usable API key. |
| `403` | `{ "error": … }`, `{ "code": "wrong_source_key" }`, `{ "code": "capability_unavailable" }` | Wrong scope, wrong key for this source, or the product has no accounts. |
| `404` | `{ "code": "unknown_source" }` | No such source for this organization. |
| `409` | `{ "code": "no_default_owner" }` | Retry once the organization has a default lead owner. |
| `429` | `{ "type": "rate_limited" \| "quota_exceeded" }` | Back off; `Retry-After` says how long. |

## Registering a source

A source is one `IntegrationSource` row: `orgId`, `slug`, `label`, `enabled`, and an optional `apiKeyId` binding.

- **slug**: 2–40 characters of `a–z`, `0–9` and `-`, starting with a letter or digit. It is the URL segment and the key every stored event is filed under, so it is **immutable**: a new name means registering a new source. The names of the other routes under `/api/integrations/` (`calendar`, `google`) are reserved.
- **label**: up to 80 characters; shown to operators and used in placeholder account names.
- **enabled**: a disabled source answers `404`, exactly like an unregistered one.
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

Every run says whether the source is on: `--disable` switches it off and a run without it switches it back on. The CLI refuses a malformed or reserved slug, an unknown organization, and a `--key` that is not a live `companies:write` key of that organization. It warns, and still writes, when the organization is not a MARKETING tenant: the writer creates marketing accounts and funnel records.

The demo seed registers a `demo-feed` source in the demo marketing tenant, so a preview environment can exercise the route once an admin has issued a `companies:write` key and set a default lead owner.

## Pull instead of push

The writer does not care how an event arrived. A later pull job that reads events from a source's own endpoint calls the same `ingestAccountEvent(orgId, source, event)` and resolves the source through the same registry; its connection settings would become further nullable columns on `IntegrationSource`.
