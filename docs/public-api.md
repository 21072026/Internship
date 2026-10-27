# The public API (`/api/v1`)

The key-authenticated, read-mostly API integrators build on (epic #1977). The
machine-readable description is `GET /api/v1/openapi.json`; this page is the
contract behind it and the rules for adding to it.

## The door

Every `/api/v1` route goes through `withApiKey(request, scope, handler)`
(`src/lib/apiKey.ts`, #1546): rate limit → key → scope → organisation binding →
plan (`INTEGRATIONS_API`) → period quota, then the handler runs inside the
key's tenant context. `npm run check:api-key-routes` fails a route that skips it,
asks for an unknown scope, or is missing from the OpenAPI document. A handler
still scopes its own query by `key.orgId` — a cross-tenant read must not wait
for `MT_ENFORCE_ISOLATION`.

**A key without an organisation is refused, on purpose (#2311).** A key carries
the `orgId` of the admin who minted it (`resolveOrgId(session)` in
`POST /api/admin/api-keys`). If that is `null`, `withApiKey()` answers
`403 org_unbound` before any handler runs. This is the decision, not a gap:
the handler scopes by `key.orgId`, so an org-less key would either read every
tenant (an unscoped query) or need a guessed fallback — and "fall back to the
default org" is exactly the silent widening the door exists to prevent. No real
account is org-less: registration, invitation acceptance and the seeder all
assign one (`defaultOrgId()`, `src/lib/defaultOrg.ts`). The only org-less admins
are test fixtures made with `seedUser()`; a spec that exercises `/api/v1` gives
its admin an org first (`e2e/integrations.spec.ts`, `e2e/api-explorer.spec.ts`).
Do not "fix" a red spec by relaxing this check.

## The contract (#1988, `src/lib/api/v1.ts`)

One module, so the eighth endpoint does not invent its own shape.

| Piece | Helper | Rule |
|---|---|---|
| List envelope | `apiOk(data, page)` | `{ data, page: { nextCursor, hasMore } }`; a single resource is `{ data }` |
| Errors | `apiError(status, type, title, detail?, extra?)` | RFC 9457, `application/problem+json`, a stable `type` slug from `API_ERROR_TYPES`; clients switch on `type`, never on `title`/`detail`. `error` repeats the message for pre-#1988 clients |
| Query | `parseListQuery(request, resource)` | `limit` (default 50, **clamped** to 200), `cursor`, `updatedSince` (strict ISO-8601 with a zone, inclusive) |
| Cursor | `encodeCursor` / `decodeCursor` | opaque base64url of `(updatedAt, id)` + an HMAC that also binds the resource |
| Keyset | `keysetWhere(query)`, `KEYSET_ORDER`, `paginate(resource, rows, limit)` | ascending `(updatedAt, id)`, fetch `limit + 1` |

Error types: `invalid_api_key` (401 — unknown, expired and revoked look the
same on purpose), `insufficient_scope`, `org_unbound`, `feature_locked` (403),
`rate_limited`, `quota_exceeded` (429, with `Retry-After`), `validation_failed`
(400, with `fields[]`), `not_found` (404).

Three rules are load-bearing:

- **A bad cursor is a 400, never page one.** A tampered cursor, a cursor that
  is not one, and a cursor minted by another list are all `validation_failed`.
  Falling back to the first page would hand a broken client the whole set again
  while looking healthy (the #831 "allowlist by omission" lesson).
- **The walk is ascending.** A row edited while a client pages moves to the end
  of the walk and is met again, rather than slipping behind the cursor. Clients
  dedupe on `id`.
- **Every paged model has the index.** A resource paged by `(updatedAt, id)`
  carries `@@index([orgId, updatedAt, id])` (additive only, never a re-key).

## Resources (#1990)

| Path | Scope | Tenant anchor | Filters |
|---|---|---|---|
| `/candidates` | `candidates:read` | `User.orgId` | — |
| `/relationships` | `relationships:read` | `MentorshipRelation.orgId` | `status`, `stage`, `mentorId`, `companyId` |
| `/interactions` | `interactions:read` (+ `interactions:read_notes` for the note body) | the relationship's org | `relationId` |
| `/meetings` | `meetings:read` | the relationship's or project's org | — |
| `/companies` | `companies:read` | `Company.orgId` | — |
| `/requisitions` | `hiring:read` | `Requisition.orgId` | `status`, `companyId` |
| `/offers` | `hiring:read` | the relationship's org (`Offer.orgId` is nullable) | `relationId`, `companyId` |
| `/interview-requests` | `hiring:read` | `InterviewRequest.orgId` | `requisitionId`, `companyId` |

Every list has a `/{id}` twin returning the same object (`src/lib/api/v1Resources.ts`
holds the one `select` + serializer per resource); another org's id is a `404
not_found`, exactly like a missing one. Filters go through `parseFilters()` — an
unknown value is a `400`, never an empty page.

**The PII line:** no resource carries an e-mail address or phone number; an
interaction's note body is returned only to a key that also holds
`interactions:read_notes`; an offer never carries compensation; a meeting's
external guests are a count, never names. A meeting with neither a relationship
nor a project (a group-conversation call) has no org anchor and is not exposed.

`updatedAt` on `MentorshipRelation`, `InteractionLog`, `Meeting` and
`Requisition` was added for the keyset (#1990) with `@default(now())`, so
existing rows start at the deploy instant. It is stamped by Prisma; a raw SQL
`UPDATE` does not move it.

The async bulk export is #3002.
## Writes (#1994, `src/lib/api/v1Write.ts`)

A write route is `withApiKey(request, '<resource>:write', (key) => apiWrite(request, key, schema, handler))`.
`withApiKey` stays the one door (the static guards look for it); `apiWrite` adds:

| Step | Rule |
|---|---|
| Write bucket | 30 writes a minute per key (`WRITE_RATE_LIMIT`), on top of the shared 120/min window → `429 rate_limited` |
| Body | JSON, ≤ 64 KB, the route's zod schema → `422 validation_failed` with `errors: [{ path, code, message }]` |
| `Idempotency-Key` | optional, 1–200 printable ASCII. Same key + same request → the stored 2xx replayed with `Idempotent-Replayed: true`, handler not run. Same key + different request → `409 idempotency_key_reused`. Still running → `409 idempotency_in_progress` + `Retry-After` |
| Record | every 2xx leaves a `logActivity` row whose detail names `api key <id>`; the handler names the action and target with `writeOk(response, { action, targetType, targetId })` |

Only successes are remembered (`ApiIdempotencyKey`, a tenant model): a refused
or failed write frees its key, so a caller that fixes its body can retry with
it. Rows are replayed for 24 hours and swept nightly at 03:40 (the count is
logged every night). A stored body over 32 KB is replayed as its status alone.
Domain events are emitted by the domain writer the handler calls, never by
`apiWrite`, so an API write and a UI write of the same thing emit the same event.

Query-parameter problems stay `400` with `fields[]`; body problems are `422` with
`errors[]`.

**Demo:** the demo instance refuses `/api/admin/api-keys` (`src/lib/demoMode.ts`),
so no key can exist there and the write API is unreachable — no entry of its own.

## Write endpoints (#1996)

| Operation | Scope | Domain path | Domain refusals |
|---|---|---|---|
| `POST /candidates` | `candidates:write` | `prisma.user.create` as MENTEE in the key's org, password nobody knows (claimed by reset) — like the CSV import | `409 duplicate_candidate` (`matches[]`): e-mail in use in this world (id only if in the key's org); a look-alike by `findPossibleDuplicates` unless `allowPossibleDuplicate: true` |
| `PATCH /candidates/{id}` | `candidates:write` | `planFieldUpdates(…, { authoritative: true })` (`src/lib/externalSyncPolicy.ts`) — a blank value is no opinion | `.strict()`: `role`, `orgId`, `email`, credentials → `422 unrecognized_keys` |
| `PATCH /relationships/{id}/stage` | `relationships:write` | `stageMoveData()` + guarded `updateMany` + `recordStageMove()` (actor null, cause `api key <id>`) — history, notification, webhook, SLA | `422 unknown_stage` (keys, not labels), `422` drop-off reason, `409 invalid_transition` (not ACTIVE), `409 stage_conflict` (moved meanwhile) |
| `POST /interactions` | `interactions:write` | `createInteraction()` (`src/lib/interactionWrite.ts`), shared with `POST /api/interactions` — one `interaction.logged` | `404` for another org's relationship |

The free-core rule holds: the scopes gate *programmatic* access only; a mentor
logging the same interaction in the app never meets a gate. The queued bulk
import is #3015.

## Connector handshake and REST hooks (#2002)

- **`GET /me`** — the one route any live key may call (`withApiKey(request,
  ANY_LIVE_KEY, …)`; `check:api-key-routes` allows it only for the files in
  `ANY_SCOPE_ROUTES`). It answers the key's id, org, scopes, expiry, minute
  window and period quota — no user or candidate data. Plan gating still applies.
- **`POST /hooks`** `{ targetUrl, event }` → `201 { data: { id, …, secret } }`
  (scope `hooks:write`, on the write floor). Same SSRF guard as the admin form
  (`422 unreachable_target`), at most `MAX_HOOKS_PER_KEY` (25) per key
  (`409 limit_reached`), the secret returned once.
- **`GET /hooks`** — the calling key's own subscriptions, no secrets.
- **`DELETE /hooks/{id}`** — ownership is in the delete's own `where`
  (`apiKeyId` AND `orgId`); any other id (another key's, an admin's, another
  org's) is the same `404`.

`Webhook.apiKeyId` / `source` are nullable and additive; admin-created rows keep
`null`. Delivery uses `liveSubscriptionsWhere()` (`src/lib/webhooks.ts`): a
key-owned subscription stops receiving the moment its key is revoked or expires.
`/api/v1/hooks` is on the demo blocklist for the same reason as
`/api/admin/webhooks`.

## Bulk candidate import (#3015, `src/lib/api/v1Imports.ts`)

- **`POST /imports/candidates`** `{ candidates: [...≤500], dryRun? }` →
  `202 { data: { id, status: 'PENDING' } }` with `Location`. Requires the scope
  `candidates:write` and goes through the write floor (Idempotency-Key, 30/min).
  The body limit is raised to 1 MB through `apiWrite(…, { maxBodyBytes })`, and
  that is the only difference. A key can have at most
  `MAX_OPEN_IMPORTS_PER_KEY` (2) imports queued or running
  (`409 limit_reached`).
- The **`api.import.candidates` job** runs the rows through THE import engine,
  `runImport` (`src/lib/importPreview.ts`). `parse` hands it the submitted rows
  as a one-column table, so there is no second parser. A dry run is the same
  call with an `apply` that writes nothing. Each row is judged by the rules of
  the single `POST /candidates`:
  - `createCandidateSchema` and the skill limits apply; a failure is ERROR with
    the field;
  - an e-mail already used in this product's world is SKIP `duplicate_email`.
    The match is named only when it is in the key's own org, and the lookup is
    one batched query (`findUsersInWorldByEmails`);
  - a repeat within the batch is SKIP `duplicate_in_batch`;
  - a look-alike, ranked against a pool loaded once, is SKIP
    `possible_duplicate` with the matches, unless the row sets
    `allowPossibleDuplicate`.

  The chunk size is 1, so a row is one `user.create`: created whole or not at
  all. The key is checked again (live, `candidates:write`, entitled) before the
  run. The submitted rows (`ApiImport.input`) are cleared when the run ends. On
  a retry after a dead attempt, rows already created are found by e-mail and
  skipped.
- **`GET /imports/{id}`** is visible only to the key that queued the import (any
  other id is 404). It returns the status and, once DONE, `counts` plus one
  report line per row (`row`, `key`, `status`, `reason`, `id`, `matches`).
  Imports are deleted 7 days after they were queued (nightly purge).
## Async exports (#3002, `src/lib/api/v1Exports.ts`)

A full snapshot of one resource without walking the cursor:

- **`POST /exports`** `{ resource }` → `202 { data: { id, status: 'PENDING' } }`
  with `Location`. On the write floor (Idempotency-Key, 30/min). The door is
  `ANY_LIVE_KEY` because the scope depends on the body. The handler calls
  `requireApiScope()` with that resource's read scope (`EXPORT_RESOURCES`)
  before it writes anything; a key without it gets the same 403 its list gives.
  A key can have at most `MAX_OPEN_EXPORTS_PER_KEY` (3) exports queued or
  running (`409 limit_reached`).
- The **`api.export` job** writes the file on the worker, never in the request.
  It reads every row of the key's org and builds them with the list route's own
  `select`, tenant filter and serializer, so there is no field and no row the
  list would not give. Note bodies follow the same rule: an interactions export
  carries them only when the key held `interactions:read_notes`, and that is
  recorded on the row as `withNotes`. The output is NDJSON, gzipped and stored
  in `ApiExport.content`, in the database like `CvFile`, because a file on one
  replica's disk is not on the other's. More than `EXPORT_ROW_CAP` (100 000)
  rows or more than 32 MB compressed makes the export `FAILED` with a code.
  The job is at-least-once: a READY or FAILED row is left alone, and the file is
  stored in one guarded update.
- **`GET /exports/{id}`**: only the key that made the export can read it; any
  other id is 404. A READY export carries a `downloadUrl` that is newly signed
  on each call. The signature is an HMAC over the id and an expiry 15 minutes
  out (never later than the file's own `expiresAt`, 24 hours after it was
  written).
- **`GET /api/exports/{id}/download?expires=&sig=`** is outside `/api/v1`,
  because every v1 route takes a key. It is listed in
  `scripts/route-auth-baseline.json`. The link is checked again on every use
  (`keyMayRead`): the making key must still be live, still hold the scopes, and
  its org must still be entitled to the API. Revoking a key kills every link it
  was given. A tampered, expired or orphaned link answers `403 invalid_link`.
- Expired exports are deleted in the nightly 03:40 slot
  (`purgeExpiredExports`); they stop being served at `expiresAt`.

## Deprecations

| What | Since | Removed on |
|---|---|---|
| `candidates` key on `GET /api/v1/candidates` (alias of `data`) | #1988 | 2027-01-31 |

## Adding an endpoint

1. A scope in `API_SCOPES` with its `SCOPE_ENTITLEMENT` entry (`src/lib/apiScopes.ts`).
2. The route: `withApiKey` → `parseListQuery` → a query filtered by `key.orgId`
   and `keysetWhere` → `paginate` → `apiOk`. No raw `NextResponse.json` for an
   error.
3. The path in `src/app/api/v1/openapi.json/route.ts`, reusing the
   `Limit`/`Cursor`/`UpdatedSince` parameters and the shared error responses.
4. An e2e spec; a security boundary (scope, tenant) is tagged `@smoke`.
5. Never add `/api/v1/*` to a k6 scenario (rate-limited, one shared runner IP).
