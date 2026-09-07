# Tenant isolation (multi-tenancy enforcement) — #543

How data is (and will be) separated per `Organization`, and how to turn on
enforcement safely.

## Where we are

Multi-tenancy shipped in additive phases:

| Slice  | What                                                                 | State |
|--------|----------------------------------------------------------------------|-------|
| #543-1 | `Organization` model + nullable `orgId` on tenant-scoped models      | live  |
| #544   | Super-admin org management                                           | live  |
| #547   | Per-tenant plan tiers + advisory limits                             | live  |
| #546   | Per-tenant white-label branding                                    | live  |
| #545   | Per-tenant SSO config + gating                                    | live  |
| #543-2 | **Enforcement** — scope every query to the request's org           | **engine shipped, gated off; per-route rollout ongoing** |

Every existing row is backfilled to a single `default` org, so the live app is
effectively single-tenant and **nothing filters by `orgId` in production** (the
flag is off).

## The enforcement building blocks (`src/lib/orgScope.ts`)

Explicit, opt-in primitives for scoping an individual query:

- `resolveOrgId(session)` — the org a request belongs to (today: the signed-in
  user's `orgId`, now carried in the JWT/session).
- `orgScoped(where, orgId)` — merge an `orgId` filter into a Prisma `where`.
- `requireOrg(session)` — returns the org to scope by; **throws** when
  enforcement is on but no org resolves (fail-closed).
- `assertSameOrg(rowOrgId, expectedOrgId)` — post-lookup IDOR guard for
  find-by-id handlers.
- `isIsolationEnforced()` — reads `MT_ENFORCE_ISOLATION` (default **off**).

## The central enforcement engine (`src/lib/orgContext.ts`)

Opt-in helpers guarantee correctness only for the call sites that remember to
use them. The acceptance criterion is stronger — *every* tenant-scoped query
must be isolated — so #543-2 adds a "can't forget the filter" layer:

- `runWithOrg(orgId, fn)` — binds `orgId` to the current request via an
  `AsyncLocalStorage` and runs `fn` inside it.
- `withTenantScope(session, fn)` — the route-handler convenience wrapper
  (`runWithOrg(resolveOrgId(session), fn)`).
- A single **Prisma `$use` middleware** (installed lazily by `runWithOrg`) then
  auto-injects `orgId` into every query on a tenant-anchored model
  (`User`, `Source`, `Company`, `Project`, `Cohort`, `MentorshipRelation`) for
  the duration of that request — `where` for reads/updates/deletes (Prisma 5
  `extendedWhereUnique` lets `findUnique`/`update`/`delete` carry the extra
  filter), `data` for `create`/`createMany`/`upsert`.

This engine is **entirely dormant unless `MT_ENFORCE_ISOLATION=true`**:
`runWithOrg` is a straight passthrough when the flag is off (no context is
established, the middleware early-returns), so single-tenant production is byte
-for-byte unchanged. It lives in `orgContext.ts` (server-only — it imports
`node:async_hooks`) and is deliberately kept out of the widely-imported
`prisma.ts` so it never enters a client bundle.

All of this is exercised against a real DB by `e2e/org-isolation.spec.ts` and
`e2e/tenant-isolation.spec.ts` — the latter proves that a **plain query which
never called `orgScoped()`** is still isolated purely because it ran inside
`runWithOrg()` with the flag on, and is a no-op with the flag off.

### Keeping the registry honest (`npm run check:tenant-models`)

The middleware only scopes models that are named in `TENANT_MODELS`. An
unregistered model is a **silent** pass-through — nothing throws and nothing
logs, so a row that carries an `orgId` column merely *looks* isolated while it
is protected by whatever `where` clause the last developer remembered. The set
drifted from the schema once and eight tenant-keyed models stayed unprotected
for months.

`scripts/check-tenant-models.mjs` (wired into `.github/workflows/ci.yml` as
`npm run check:tenant-models`) compares the two lists on every PR and fails in
both directions:

- a model in `prisma/schema.prisma` that declares `orgId` and is not registered;
- a name in `TENANT_MODELS` that is not a model, or is a model that no longer
  has the column — a typo is the same silent no-op as a missing entry.

Two escape hatches live inside the script, and both require a written reason.

`EXEMPT` is for a model that is deliberately never auto-scoped. Today it holds
one name: `Organization`, which *is* the tenant rather than a row inside one and
can never grow an `orgId` of its own. An exemption is only granted against a
schema someone has read. `Setting` is the worked example: it was deliberately
left un-exempted while its column was still only planned, the check duly failed
the day #1553 added `orgId`, and the call was then made against the real shape —
**registered, not exempt**, with its own readers opting out (see
[Settings: per-tenant with a global fallback](#settings-per-tenant-with-a-global-fallback-1553)
below).

`PENDING_REGISTRATION` is for a model that is known to be unprotected and is
waiting on its own reviewed change — the eight models of #1559. It is a ratchet,
not an allowlist:

- every run prints each pending model with its own reason, and in CI emits a
  GitHub **warning annotation** on `src/lib/orgContext.ts`, so the PR page shows
  the unprotected set instead of burying it in a green step's log;
- while anything is pending the summary line does **not** say "OK" — it reads
  `no NEW drift, but N model(s) remain unprotected`;
- the list length is pinned by an `EXPECTED_PENDING` literal, so a ninth
  unprotected model cannot be waved through by appending a line: the number has
  to move in the same diff, in front of a reviewer;
- an entry that has since been registered, or whose model lost its `orgId`,
  fails the check until it is deleted.

So the guard's job while #1559 is open is to stop the set of unprotected models
from *growing*, and to say on every run exactly which ones they are.

### Settings: per-tenant with a global fallback (#1553)

`Setting` is the one tenant model that must be able to read *outside* its tenant,
and it is worth understanding before touching it.

Eighteen product decisions — `require2fa`, `retentionMonths`, `aiMonthlyQuota`,
`selfRegistration`, `blindReview`, the newsletter cadence — live in this one
key/value table. It is now keyed by **(`orgId`, `key`)**:

| `orgId` | meaning |
|---------|---------|
| a tenant id | that tenant's override |
| `NULL` | the **global** layer: the platform-wide value every tenant inherits until it sets its own, and the only layer a single-tenant installation ever writes |

Resolution is **org row → global row → `SETTING_DEFAULTS`**, and that rule lives
in exactly one file, `src/lib/settings.ts`. Nothing else reads `prisma.setting`
directly — `getSetting(key, orgId?)` / `getSettings(orgId?)` / `setSetting(key,
value, orgId?)` are the whole surface. The org argument is optional: omitted, it
resolves to the org bound by `withTenantScope()` (`currentOrgId()`), and to the
global layer when no org is bound. That is what keeps the ~20 existing
zero-argument call sites correct without changing any of them, and what makes a
single-tenant deployment behave exactly as it did before.

**The auto-filter had to be opted out of, on purpose.** `Setting` *is* registered
in `TENANT_MODELS`, so any code that reaches for `prisma.setting` outside this
module is scoped to its own tenant like everything else. But with enforcement on,
that same middleware would rewrite the readers' query to `where: { orgId: <tenant> }`
— which is precisely the filter that hides the `orgId = NULL` row and would turn
step 2 of the chain into a silent "code default" for every tenant. So the queries
in `settings.ts` run inside `runWithOrg(null, …)`, which clears the tenant context
for the duration and lets the module see both layers. This is safe because the
module computes the org itself, from the bound context, and never from request
input: `PUT /api/admin/settings` passes no org at all, so a tenant admin can only
ever write their own row.

It reaches both of those through `src/lib/tenantAmbient.ts` rather than importing
`orgContext.ts` directly, and that indirection is load-bearing rather than
stylistic. `orgContext.ts` imports `node:async_hooks`, and `settings.ts` sits in a
**client** module graph — a client component imports a constant from
`documentAccess.ts`, which reaches `settings.ts` via `retention.ts` — so a direct
import fails the production build outright with `Reading from "node:async_hooks"
is not handled by plugins`. `tenantAmbient.ts` imports nothing, holds two function
slots, and `orgContext.ts` fills them as a side effect of being loaded; every
request that binds a tenant has loaded it, because `withTenantScope` lives there.
If it was never loaded, the fallbacks (no bound org, call `fn` directly) are the
right answers anyway — there is no middleware installed to escape from. The same
seam is the way in for any other client-reachable module that needs the bound org.

Uniqueness has a MySQL wrinkle worth knowing: the pair is enforced by
`@@unique([orgId, key])`, and MySQL treats `NULL`s as distinct in a unique index.
The constraint therefore binds the per-tenant rows only; the global layer stays
single because `setSetting()` is its only writer and does a read-modify-write
rather than a blind insert. (`upsert` is not an option either way — a compound
unique cannot address a `NULL` component.)

Existing rows keep `orgId = NULL` and go on working as the global layer;
`prisma/backfill-organization.mjs` excludes `Setting` by name for exactly this
reason. Stamping them with the `default` org would turn platform-wide defaults
into one tenant's private settings and leave every other tenant with nothing.

### Per-route rollout status

Handlers adopt the engine by wrapping their body in `withTenantScope(session, …)`.
**All authenticated API routes that query a tenant-anchored model are now
wrapped** — every such handler binds the request's org, so with the flag on the
central middleware scopes all of its queries. Wrapping is behavior-neutral while
the flag is off (`withTenantScope` is a pure passthrough).

Public / token-based routes (registration, apply, forgot-password, invite
acceptance) are intentionally not wrapped: they have no session and resolve their
subject from the invite/reset token, not a tenant context. Routes that only ever
read the caller's own rows (account, profile, avatar, cv) are wrapped too for
uniformity, though scoping is redundant there.

### API-key requests have no session — so they bind their org themselves (#1546)

`withTenantScope(session, …)` resolves the org from the session. A request to
`/api/v1/*` authenticates with a Bearer API key and has **no session at all**,
so `resolveOrgId()` returns null, `currentOrgId()` stays `undefined`, and the
middleware reads that as *"no context — do not scope"*. A key-authenticated
route that queried a tenant model therefore read **every** organisation's rows
while looking entirely ordinary; that is what `GET /api/v1/candidates` did.

The public API is now entered through one door, `withApiKey()`
(`src/lib/apiKey.ts`), which — before the handler body runs — refuses an
unknown, expired or revoked key (401), a key that does not hold the operation's
scope (403) and a key that resolves to **no** organisation (403, never an
unscoped read), then runs the handler inside `runWithApiKeyOrg(key.orgId, …)`.

Two things keep it that way:

- the handler's `where` also carries `orgId: key.orgId` **explicitly**. The
  middleware only engages when `MT_ENFORCE_ISOLATION=true`, and a cross-tenant
  read must not wait for a flag;
- the absence of a tenant context is made loud rather than silent, in both
  halves: `assertApiKeyRequestContext()` throws in development when a key is
  authenticated outside `withApiKey()`, a development-only Prisma middleware
  throws when a tenant-anchored model is queried inside an API-key request with
  no org bound, and `npm run check:api-key-routes` fails the build for a
  `/api/v1` route that queries the database without going through the door.

## Turning enforcement on (the guarded rollout)

Do **not** set `MT_ENFORCE_ISOLATION=true` in production until every step below
is done and verified in a preview/staging environment first:

1. **Backfill every `orgId`, then assign real orgs.** This is the step that
   cannot be skipped: with the flag on, the middleware injects
   `where: { orgId }` into every query on a tenant model, so a row left at
   `orgId = NULL` matches nobody and **disappears from the product**.
   `prisma/backfill-organization.mjs` assigns the `default` org to every
   nullable `orgId` column in the schema — the model list is derived from the
   Prisma DMMF, so it cannot drift from `prisma/schema.prisma`. It runs on
   **every** deploy that touches a database: prod and preview
   (`infra/deploy-prod.sh`), per-PR topic environments
   (`infra/server/topic-deploy.sh`) and the demo box
   (`infra/server/demo-refresh.sh`); `prisma/seed.mjs` and
   `prisma/seed-demo.mjs` call the same derived pass (`assignDefaultOrg`) so a
   freshly seeded database is complete too. Models whose `orgId` is `NOT NULL`
   are skipped — they cannot hold NULLs — and `Setting` is excluded by name
   ahead of #1551 giving it an `orgId`, because its `NULL` rows are the global
   fallback layer that applies to every tenant.
   It **exits non-zero if any NULL survives its retry passes**, so a partial
   backfill cannot pass as done; verify it is green *before* flipping the flag
   in any environment. The pass is deliberately raw SQL, so it does not restamp
   `@updatedAt` on the rows it touches, and it retries rather than failing on
   the first leftover, because ordinary traffic (a failed sign-in, the public
   company-inquiry and mentor-application forms) inserts `orgId = NULL` rows
   while the old container is still serving. While there is one `default` org
   the assignment is a formality; once multiple tenants exist, ensure every
   user/row has the *correct* `orgId`, not just a non-NULL one.
2. **Plumb request→org resolution** everywhere reads/writes happen — either via
   the session `orgId` (done) or host/subdomain for public routes.
3. **Wrap every API route** body in `withTenantScope(session, …)` so the central
   middleware auto-scopes all its queries. (The `orgScoped`/`assertSameOrg`
   helpers remain available for call sites that want explicit, local scoping —
   e.g. background jobs with no session context.) Add per-org uniqueness where
   needed (e.g. slugs).
4. **Run the full isolation suite** with `MT_ENFORCE_ISOLATION=true` against a
   seeded two-tenant DB; confirm no cross-tenant read/write passes.
5. **Flip the flag** in one environment, watch, then production. It is a single
   env var so rollback is instant.

Until then the flag stays off and the single-tenant production app is unchanged.
