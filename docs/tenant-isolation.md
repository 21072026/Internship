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
   are skipped — they cannot hold NULLs.
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
