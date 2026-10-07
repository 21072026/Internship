# Audit stream (SIEM drain)

**Issue:** #2012 · **Code:** `src/lib/auditDrainRule.ts` (the rules, pure, unit-tested in
`scripts/test/audit-drain.test.mjs`), `src/lib/auditDrain.ts` (Prisma + HTTP + the schedule),
`src/app/api/admin/audit-drains/*` (the admin API), `src/components/admin/AuditDrainsCard.tsx`
(the console on `/admin/integrations`) · **E2E:** `e2e/audit-stream.spec.ts` against
`e2e/support/audit-sink.mjs`.

A tenant can stream its **audit trail** — the `AuditLog` table: impersonation start/stop,
password and 2FA resets, forced sign-outs, lockouts, SSO exemptions, account merges, offer and
interview-request decisions, meeting cancellations, trial expiries — to its own SIEM. The
stream is a sequence of signed HTTP POSTs ("batches") to a URL the tenant registers (a
"drain"). This document is the contract a receiver programs against.

## What a drain is — and is not

- **One tenant, forward only.** A drain ships the rows of *its* `orgId`, in `(createdAt, id)`
  order, from a cursor that is the last row the receiver acknowledged. The cursor moves **only
  on a 2xx answer**, so a receiver outage is *replayed* from where it stopped and never loses
  a row.
- **At-least-once.** A batch the receiver accepted but whose answer we did not see (timeout,
  connection reset) is sent again. A receiver that stores rows keys them by `id` and treats a
  repeat as a no-op. There is no "exactly once" and there will not be.
- **Never a write to the audit trail.** The stream reads `AuditLog` and updates its own
  bookkeeping row (`AuditDrain`). Nothing in it edits or deletes an audit row.
- **No retention of its own.** The age-based sweep of audit rows is #1585's, on #1678's single
  schedule. The one way the two interact: a row swept before it was shipped is gone silently —
  which is why the retention window is a floor on how long a drain may be down before the
  tenant has a gap. The console shows the cursor so that gap is visible, not guessed.
- **Not a webhook.** Webhooks (`docs/…`, `src/lib/webhooks.ts`) carry domain events to
  integrators and are fire-and-forget with a short retry. The audit stream carries a *log*,
  is cursor-based, and backs off for hours. They share the signature recipe on purpose, so an
  integrator verifies both the same way.

## Registering a receiver

`POST /api/admin/audit-drains` with `{ "url": "https://…", "format": "json_lines" | "ecs" }`
(ADMIN, and the org needs the `INTEGRATIONS_API` entitlement, #1744 — the same gate as a
webhook subscription). The response carries the **signing secret once**; it is never listed
again. `POST /api/admin/audit-drains/rotate-secret?id=…` mints a new one (also returned once).

The URL is checked twice, at registration **and at every delivery** (#893: DNS moves):

| Refusal | Why |
|---|---|
| `not_https` | https only. The one exception is the e2e switch below. |
| `credentials` | `https://user:pw@…` — a secret in a URL ends up in logs. |
| `too_long` | > 2000 characters (`AUDIT_DRAIN_URL_MAX`). |
| `invalid` | not a URL. |
| `blocked` | the SSRF guard (`assertPublicHttpsUrl`): loopback, private ranges, link-local, the cloud metadata address, a served host of ours. |

`PATCH …?id=` edits `url`, `format` or `active`; it never touches the secret and never moves
the cursor — a re-pointed drain continues from where the old receiver left off. Resuming a
paused drain clears its failure bookkeeping so the next tick tries it. `DELETE …?id=` removes
the drain (and its cursor; a new drain to the same URL starts from the beginning of the trail).
Every call is scoped to the caller's org in the query; another tenant's drain is a 404.

## The batch

```
POST <url>
Content-Type: application/x-ndjson
X-Signature: sha256=<hex HMAC-SHA256 of the exact body bytes, keyed with the secret>
X-Audit-Batch-Id: <uuid, new per attempt>
X-Audit-Count: <number of lines>
X-Audit-Format: json_lines | ecs
X-Audit-Test: 1            (only on the synthetic test batch, see below)

{"id":"…","orgId":"…","action":"IMPERSONATE_START","actorId":"…","targetId":"…","detail":null,"createdAt":"2026-10-07T05:00:00.000Z"}
{"id":"…", …}
```

- One JSON object per line, newline-terminated (`\n`), at most **200 lines** per batch
  (`AUDIT_DRAIN_BATCH_SIZE`). A tick ships at most **10 batches per drain**, so a long outage
  catches up over a few ticks rather than in one unbounded burst.
- **Verify** by recomputing `HMAC-SHA256(secret, raw body)` and comparing to `X-Signature`
  with a constant-time comparison. Do not parse first and re-serialise: the signature is over
  the bytes as sent. Answer **2xx** to acknowledge; anything else (or no answer within **10 s**)
  is a failure and the batch will be sent again.
- `X-Audit-Batch-Id` identifies an *attempt*, not the content: a replayed batch after a
  timeout carries a new id and the same rows. Deduplicate on the rows' `id`, not on the batch.

### `json_lines` — our record

Every column of `AuditLog`, named as the table names it:

| Field | Type | Notes |
|---|---|---|
| `id` | string | cuid; the dedupe key |
| `orgId` | string | the tenant — always the drain's own |
| `action` | string | e.g. `IMPERSONATE_START`, `USER_MERGE`, `offer.expire` |
| `actorId` | string | the user who acted, or the literal `system` |
| `targetId` | string \| null | the affected user, when there is one |
| `detail` | object \| array \| string \| null | the row's free text; **parsed when it is JSON**, the string otherwise |
| `createdAt` | ISO-8601 UTC | |

### `ecs` — Elastic Common Schema

The subset every SIEM maps, with the whole original record kept under `interncrm.audit`:

```json
{
  "@timestamp": "2026-10-07T05:00:00.000Z",
  "event": { "id": "…", "action": "IMPERSONATE_START", "kind": "event", "dataset": "interncrm.audit", "created": "…" },
  "user": { "id": "<actorId>" },
  "user_target": { "id": "<targetId>" },
  "related": { "user": ["<actorId>", "<targetId>"] },
  "organization": { "id": "<orgId>" },
  "message": "IMPERSONATE_START by <actorId> on <targetId>",
  "interncrm": { "audit": { …the json_lines record… } }
}
```

## Delivery schedule, backoff, pause

A tick runs **every five minutes** in the app process (`initAuditDrainCron`, registered from
`/api/cron/start` like the other crons; an admin can force one with
`GET /api/cron?job=audit-drain`, which answers with the tick's counters). Each tick walks every
active drain whose backoff has elapsed and ships its next batches.

On a failure the cursor stays, `failures` counts up and the next attempt waits
**1 min → 5 min → 15 min → 1 h → 6 h** (capped). After **20 consecutive failures** (≈ 3.5 days
at the cap) the drain **pauses itself** (`active = false`, the reason in `lastError`, shown on
the console and on the connector-health board as *failing*) rather than knocking on a dead
receiver forever. A human fixes the receiver and presses *Resume*; the stream continues from
the cursor.

The job name `audit.drain` is reserved in `src/lib/jobs/types.ts` for the day #1673's worker
takes over the schedule; `runAuditDrains()` is the handler either way.

## The test batch

*Send test batch* on the console (`POST /api/admin/audit-drains/test?id=…`, 3/min per drain)
POSTs **two synthetic rows** — invented ids prefixed `test-`, actor `test-actor`, action
`audit.drain.test` — signed exactly like a real batch and flagged `X-Audit-Test: 1`, so an
integrator proves the receiver and the signature before a single real row leaves and can keep
the probe out of the real index. It never ships real rows, never moves the cursor and never
counts towards the pause ceiling. The outcome (`lastOkAt` / `lastError`) is recorded so the
console shows it.

## Tenant scoping — how it is guaranteed

`AuditLog` gained a nullable `orgId` (#2012; registered in `TENANT_MODELS`). The stream's read
is `where: { orgId: drain.orgId, … }` — the whole isolation story: a drain never sees another
tenant's row because the query never asks for one. Two consequences to know:

- **Every writer of `AuditLog` passes `orgId` explicitly** (the impersonation routes, the admin
  user actions, the merge, the offer/interview/meeting routes, the offer-expiry sweep). The
  Prisma middleware stamps it only under `MT_ENFORCE_ISOLATION`, which is still off, so a
  writer that forgets produces a row **no** drain receives — a silent gap, not a leak. A new
  `prisma.auditLog.create` must pass `orgId`.
- **Legacy rows** are attributed on deploy by `prisma/backfill-audit-log-org.mjs` (the actor's
  org, then the target user's) **before** `backfill-organization.mjs` hands what is left —
  system rows — to the default org. The order matters: the generic pass would otherwise give a
  MARKETING admin's resets to the INTERNSHIP tenant's SIEM.
- Rows whose `orgId` is still `NULL` are **not** folded into the default org by the stream (the
  way `tenantFilter` folds them for reads): a row whose tenant is unknown is a row no tenant's
  SIEM should get.

## The e2e switch

`AUDIT_DRAIN_ALLOW_INSECURE_RECEIVERS=1` lets a plain-http loopback URL pass both the URL rule
and the SSRF guard, so `e2e/support/audit-sink.mjs` can act as the receiver. It is set only by
`playwright.config.ts` on the app server it starts, is read per call (not cached), logs a warning
when it takes effect, and is **never set on a deployment**. Do not reach for it to "make a
receiver work" — fix the receiver's TLS.
