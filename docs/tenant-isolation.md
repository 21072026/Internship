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
schema someone has read, so `Setting` is **not** pre-exempted even though its
column is coming: when #1551 adds `orgId` to `Setting` this check will fail, and
the register-vs-exempt call gets made then, against the real shape. (#1557
records the intent — `Setting`'s legacy rows will stay `orgId = NULL` as the
global fallback layer — but #1560 also says `Setting` must be *registered* and
behave specially, and those two have to be reconciled with the column in hand.)

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
