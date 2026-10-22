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
- **The only event table.** The transactional outbox (#1680) adds its relay
  columns (`status`, `relayedAt`, `attempts`) to this model; there is no
  `OutboxEvent`.
- **Retention**: the `domainEvent` entry of the one retention registry
  (`src/lib/retentionEntries.ts`, #1678), window `domainEventRetentionDays`
  (global setting, default 90 days). No schedule of its own. Once the outbox
  lands, a row not yet relayed must be excluded in `pruneDomainEvents()`.
