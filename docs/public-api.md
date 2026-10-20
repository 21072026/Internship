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
