# Domain events

The event spine (story #1683). This page grows with each task; today it covers
the vocabulary and the record (#1691).

## One catalogue: `src/lib/events/catalog.ts`

Every event the product can raise is one entry: `name`, `version`,
`subjectType` (a Prisma model name) + optional `subjectKey` (the payload field
holding that row's id), a **zod** payload schema, `visibility`
(`public` | `internal`) and a one-line description.

- **`name` + `version` is the identity.** A change a receiver would notice is a
  new entry at `version: 2`, never an edit of version 1. `latestEventVersion()`
  and `getEventDefinition()` resolve it; `validateEventPayload()` is the runtime
  gate (it never throws).
- **Public entries are the webhook contract.** `WEBHOOK_EVENTS` is derived from
  them, in catalogue order, and `src/lib/webhooks.ts` re-exports it — the admin
  form, the zod enum of `/api/admin/webhooks` and the unauthenticated
  `x-webhooks` block of `/api/v1/openapi.json` all read it. Reordering or
  renaming a public entry changes a published list.
- **Version 1 payloads are what producers dispatch today**, `.strict()`.
  `meeting.scheduled` has three producers and `interaction.logged` two; v1
  describes every shape as it ships, with the producer-specific keys optional.
  Events registered but not raised yet (no producer written so far) carry the
  shape they will ship with: ids only.
- **Internal entries** (`org.config.changed`, `setting.changed`,
  `webhook.registered`, `apikey.*`, `relation.created`, `meeting.completed`,
  `user.invited`, `email.bounced`) are never offered as webhooks. Ids only: a
  consumer that needs a name or an address reads it from the record. The
  configuration events also carry `changes`, the redacted diff (below).

`e2e/domain-event-catalog.unit.spec.ts` pins the public list and every
producer's payload.

### Not the notification catalogue

`src/lib/notifications/catalog.ts` names what a **person is told**; this one
names what **happened**. One event can cause zero, one or several notifications
(`pipeline.stage_change` → `stage.changed`). They stay two files on purpose and
neither derives from the other.

## One table: `DomainEvent`

Append-only, one row per raised event: `orgId`, `name` (≤ 96), `version`,
`payload`, `actorId`/`actorType` (`user` | `system` | `apikey`),
`subjectType`/`subjectId`, `correlationId`, `createdAt`.

- **Tenant data**: registered in `TENANT_MODELS`. Background readers (the
  outbox relay, the retention sweep) have no session — they filter by `orgId`
  themselves or bind an explicit context, or with `MT_ENFORCE_ISOLATION` on
  they see the wrong set of rows.
- **The only event table.** The transactional outbox (#1680) adds its relay
  columns (`status`, `relayedAt`, `attempts`) to this model; there is no
  `OutboxEvent`.
- **Retention**: the `domainEvent` entry of the one retention registry
  (`src/lib/retentionEntries.ts`, #1678), window `domainEventRetentionDays`
  (global setting, default 90 days). No schedule of its own. Once the outbox
  lands, a row not yet relayed must be excluded in `pruneDomainEvents()`.

## One way in: `emit()` (#1693)

```ts
import { emit } from '@/lib/events/emit';
await emit('mentorship.created', { relationId, mentorId, menteeId, companyId }, { orgId, actor: { id, type: 'user' } });
```

`src/lib/events/emit.ts` (server-only) binds the rules in
`src/lib/events/emitCore.ts` (dependency-free, unit-tested in
`e2e/domain-event-emit.unit.spec.ts`) to Prisma and the job queue:

1. **Validate** against the catalogue. An unknown name or a payload the entry
   does not describe **throws outside production** (a red test, not a silent
   contract change) and is logged and dropped in production.
2. **Record** one `DomainEvent` row — `orgId` (explicit, else
   `currentOrgId()`; an explicit `null` stays null), actor, `subjectType`/
   `subjectId` from the entry, `correlationId` (default: the request id).
   Until the transactional outbox (#1680) lands, `insertDomainEvent()` in
   `emit.ts` is the only insert into the table; #1680 swaps it for
   `publishEvent(tx, …)` and moves step 3 into its relay.
3. **Fan out**: one `event.deliver` job per interested subscriber, payload
   `{ eventId, subscriber }` (names only — the handler is resolved by name in
   the worker), `idempotencyKey = <eventId>:<subscriber>`, `trigger: 'event'`.
4. **Never throws** past step 1: a failed row write or enqueue is logged, like
   `logActivity`.

The `event.deliver` job (`src/jobs/index.ts`) loads the row, re-parses the
payload through its catalogue entry — which restores the producer's key order
that MySQL's JSON column re-sorts — and calls the subscriber. A missing row
(pruned) or a subscriber that no longer exists settles without a retry; a
subscriber that throws is retried with the queue's backoff.

### Subscribers: `src/lib/events/subscribers/`

`registerSubscriber({ name, events, handle })` (`subscribers.ts`, pure);
every production subscriber is registered in `subscribers/index.ts`. Delivery
is at-least-once — each subscriber says in its file what makes a rerun
harmless.

- **`webhook`** (`subscribers/webhook.ts`): every public event → one
  `webhook.deliver` job per live subscription of the event's tenant (#1695),
  keyed `whk:<eventId>:<webhookId>` so a rerun of the fan-out enqueues nothing
  twice. The job (`src/lib/webhookDelivery.ts`, rules in
  `webhookDeliveryRule.ts`) signs and posts the same `event`/`data` the
  producers used to pass directly, writes one `WebhookDelivery` row per attempt,
  retries a 5xx/timeout with the queue's backoff and auto-disables a hook after
  20 failures or 72h without a success. One slow receiver holds only its own
  job. `src/lib/webhookDelivery.ts` is the one file besides `src/lib/webhooks.ts`
  that may name the deliverer (`npm run check:events`); the retry semantics a
  receiver sees are in [`api-explorer.md`](api-explorer.md) § Webhook delivery.
- **`config-audit`** (`subscribers/configAudit.ts`, #1699): every
  configuration event (`CONFIG_AUDIT_EVENTS` — `org.config.changed`,
  `setting.changed`, `webhook.registered|updated|deleted`, `apikey.created|revoked`)
  → one `AuditLog` row: `action` = the event name, `targetId` = its subject,
  `orgId` = its tenant (explicit; a global setting stays `null`), `detail` =
  `{"eventId":…,…payload}`. A rerun finds the row by the event id that opens
  `detail` and writes nothing.
- **`automation`** (`subscribers/automation.ts`, #1703): `pipeline.stage_change`
  → the org's enabled stage automation rules for that move, one `AutomationRun` per
  (rule, event) — unique, so a rerun creates none. `docs/automation-rules.md`.

### Inside a transaction: never `emit()` directly (#1998)

`emit()` writes through the global Prisma client, so an `emit()` from inside an
interactive transaction survives that transaction's rollback — a ghost event.
`Application.stage` is always written inside its caller's transaction, so its
writer `moveApplicationStage()` only **notes** each move
(`noteStageMove()`, `src/lib/applicationStageEvents.ts`), and every caller
opens its transaction with `stageTransaction(fn, options)` instead of
`prisma.$transaction`: once the transaction resolves, one
`application.stage_changed` per noted move is raised. A rejected transaction
raises nothing; a move noted outside the wrapper throws outside production.

## Configuration diffs: `src/lib/events/diff.ts` (#1699)

`redactedDiff(before, after, spec)` is the **only** before/after diff in the
tree — the organization PATCH, the webhook and API-key routes and the settings
writer (#1623) pass their own spec into it.

- **Read the row before the write** and diff it against the row after; a diff
  built from the response has no "before".
- `spec` maps a field to `record` (both values), `redact` (`[redacted]` + the
  first 8 hex of a SHA-256 of each side, so a real change differs from a
  re-save) or `ignore`. **A field the spec does not list is redacted** — a
  column added later cannot leak. A field whose name ends in a secret word
  (`…Secret`, `…Certificate`, `…Token`, `hashedKey`, `…Password`, …) is
  redacted even if a spec says `record`.
- Recorded strings are cut at 200 characters (a logo may be an inline image).
- The specs of the audited records live next to the helper
  (`ORGANIZATION_DIFF_SPEC`, `WEBHOOK_DIFF_SPEC`, `API_KEY_DIFF_SPEC`); the
  settings catalogue derives its own from `SETTING_SCHEMA`'s `redact` flag.
- The route's existing `ActivityLog` entry (field names only, `warning` on SSO)
  stays: the operational feed and the audit trail serve different readers.

`e2e/config-change-events.unit.spec.ts` pins the policy and that no secret
reaches a payload or `AuditLog.detail`; `e2e/config-change-audit.spec.ts` drives
an SSO change through the worker.

### Producers (#1697)

Every event the product raises today goes through `emit()`; the ten former
direct `dispatchWebhook` callers moved over one-for-one with the same payload
and the same `orgId` (the unit spec pins byte-identical webhook `data`):
`application.created` (`/api/apply`, no actor), `pipeline.stage_change`
(`emitStageChange()`, after its `from === to` no-op guard), `mentorship.created`
(`POST /api/mentorship`), `interaction.logged` (`createInteraction()` — actor
`user`, or `apikey` through `/api/v1`; and the auto-log in `meetingAutoLog.ts`,
actor `system`), `evaluation.added`, `meeting.scheduled` (batch invite, instant
meeting, recurring series — the one v1 schema with its producer-specific
optional keys) and `interview_panel.completed`.

What changed for a receiver is only *when*: the POST is sent by the job worker
(a tick every 5 s) instead of inside the producer's request, so a slow receiver
no longer slows the request that raised the event.

`npm run check:events` (CI) refuses any other file that names
`deliverToWebhook` (or the removed `dispatchWebhook`) (the admin's test ping is the one
allowlisted deliverer) and any hand-written `activityLog`/`auditLog` create
whose `action` is a catalogue event name.
