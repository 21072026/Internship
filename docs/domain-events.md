# Domain events

The event spine (story #1683). This page grows with each task; today it covers
the vocabulary and the record (#1691) and the transactional outbox (#1680).

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
  Events registered but not raised yet (they wait on `emit()`, #1693) carry the
  shape they will ship with: ids only.
- **Internal entries** (`org.config.changed`, `setting.changed`,
  `webhook.registered`, `apikey.*`, `relation.created`, `meeting.completed`,
  `user.invited`, `email.bounced`) are never offered as webhooks. Ids only: a
  consumer that needs a name or an address reads it from the record.

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
- **The only event table.** The transactional outbox (#1680) put its relay
  columns (`status` PENDING/RELAYED/FAILED, `relayedAt`, `attempts`) on this
  model; there is no `OutboxEvent`.
- **Retention**: the `domainEvent` entry of the one retention registry
  (`src/lib/retentionEntries.ts`, #1678), window `domainEventRetentionDays`
  (global setting, default 90 days). No schedule of its own. Only RELAYED and
  FAILED rows are pruned — a PENDING row is an event nobody heard yet.

## Writing an event: `src/lib/events/publish.ts` (#1680)

The outbox **is** the bus: the event row is written in the same transaction as
the change it describes, so both commit or neither does.

| Caller has | Use |
|---|---|
| an interactive `$transaction(async (tx) => …)` | `publishEvent(tx, input)` — the type refuses the root client (`EventTx` has no `$transaction`), and so does a runtime check |
| an array `$transaction([...])` | `publishEventOp(input)` as one element |
| no transaction | `withEvents(({ tx, publish }) => …)` |

Every payload is validated against the catalogue and an invalid one **throws
inside the transaction**, rolling the caller's write back. `orgId` is always
passed explicitly. `correlationId` defaults to the request id in flight.
`createdAt` is a per-process monotonic stamp, so two events of one transaction
never tie. After a commit, `kickRelay()` (done by `withEvents` itself) runs a
relay pass in-process; it is only latency.

**Fallback, not atomic:** `publishAfterCommit(input)` writes the event after a
write that already committed and never throws. It exists for producers that
cannot share their transaction yet — each one is a burndown entry below.

### `pipeline.stage_change`

`stageChangeEvent()` (`src/lib/stageChangeEffects.ts`) builds the event. Atomic
today, inside the move's own transaction: `PUT /api/mentorship/[id]`,
`POST /api/admin/candidates/bulk` (advance), `POST /api/status-changes`. They
pass `eventPublished: true` on to `recordStageMove()` / `emitStageChange()`.

**Burndown — still `publishAfterCommit` from `emitStageChange()`:** the
accepted-offer auto-advance (`src/lib/offerAutoAdvance.ts`), the interview-panel
outcome, the account-event feed (`src/lib/accountEventIngest.ts`), the trial
route (`/api/mentorship/[id]/trial`) and the marketing import. Moving one means
writing `stageChangeEvent()` into its transaction and passing `eventPublished`.
The webhook still leaves through `dispatchWebhook()` in `emitStageChange()`
until the webhook subscriber (#1695) takes it over.

## Relaying: `src/lib/events/relay.ts` (#1680)

`relayOnce()` turns committed rows into `events.deliver` jobs — one per
subscriber (`subscribersFor(name)`, `src/lib/events/subscribers.ts`; the
subscribers themselves are #1693).

- **Mail-drain shape:** ticked every 30 s on **every replica**
  (`POST /api/events/relay`, from `src/instrumentation.ts`), rows claimed with
  `FOR UPDATE SKIP LOCKED`, **no lease**. `EVENTS_RELAY_ENABLED=0` switches it
  off (the deploy canary; the e2e servers, where specs drive `relayOnce()`).
- **One row, one transaction:** claim → per-subject order check → insert the
  jobs (keyed `${eventId}:${subscriber}`, duplicates skipped) → mark RELAYED,
  guarded on PENDING. A relay retried after its jobs committed cannot deliver
  twice.
- **Per-subject order:** a row waits while an older PENDING row of the same
  subject exists; delivery jobs carry `runAt = event.createdAt`, so the queue
  hands them out in event order.
- **Failures:** counted outside the rolled-back transaction; after
  `OUTBOX_MAX_ATTEMPTS` (10) the row is parked `FAILED` and stops blocking its
  subject.
- **No session:** it binds `runWithOrg(null, …)` itself — a kick inherits the
  publishing request's tenant, and with `MT_ENFORCE_ISOLATION` on that would
  scope the relay to one org. `e2e/outbox-relay.spec.ts` proves it with the
  flag on.
