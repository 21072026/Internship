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
  auto-injects `orgId` into every query on a tenant-anchored model for the
  duration of that request — `where` for reads/updates/deletes (Prisma 5
  `extendedWhereUnique` lets `findUnique`/`update`/`delete` carry the extra
  filter), `data` for `create`/`createMany`/`upsert`.

The set of anchored models is `TENANT_MODELS` in `src/lib/orgContext.ts`, and
**that file is the list** — this doc does not repeat it, because a copied list is
a list that goes stale (it named six models for months while the set held eleven).
Since #1559 the rule holds without exception: **every** model in
`prisma/schema.prisma` that declares an `orgId` is registered, and
`npm run check:tenant-models` fails the build in both directions if that ever
stops being true.

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

Both of those run **in the Playwright process**, though: they flip
`MT_ENFORCE_ISOLATION` in their own env and call the helpers directly, so they
say nothing about the deployed server. The `isolation` Playwright project
(#1566) covers that half — `npm run test:e2e:isolation` boots a second app
server on port 3010 with the flag genuinely on and runs `e2e/isolation/**`
against it, using the two-tenant fixture in `e2e/helpers/tenants.ts`. See
[`docs/testing.md`](testing.md#tenant-isolation-the-isolation-playwright-project-1566).

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
waiting on its own reviewed change. **It is empty since #1559** — the eight
models it was created for are registered (see the section below) — but the
mechanism stays for the next one. It is a ratchet, not an allowlist:

- every run prints each pending model with its own reason, and in CI emits a
  GitHub **warning annotation** on `src/lib/orgContext.ts`, so the PR page shows
  the unprotected set instead of burying it in a green step's log;
- while anything is pending the summary line does **not** say "OK" — it reads
  `no NEW drift, but N model(s) remain unprotected`;
- the list length is pinned by an `EXPECTED_PENDING` literal (**0** today), so
  an unprotected model cannot be waved through by appending a line: the number
  has to move in the same diff, in front of a reviewer;
- an entry that has since been registered, or whose model lost its `orgId`,
  fails the check until it is deleted.

With the list empty the guard is back to green-means-clean: every model with an
`orgId` is registered, and the summary line says `tenant models OK`. While
something *is* pending, the guard's job is to stop that set from growing and to
say on every run exactly which models it holds.

One parsing note, learned the hard way: the guard locates `TENANT_MODELS` by
matching `new Set([ … ])` in the source text, with the closing `])` **anchored to
the start of a line**. The entries carry prose, and prose carries brackets — a
`])` written mid-comment (naming an `@@unique` pair, say) used to end the match
there and report every name below it as unregistered. It fails closed, but the
report then blames the schema for a comment.

### The eight late registrations (#1559)

Eight models carried a tenant key from the day they were added and were never
listed in `TENANT_MODELS`, so for months they were scoped only by whatever
`where` clause each call site remembered. Registering them changes **writes** as
well as reads — `create`/`createMany`/`upsert` get `orgId` filled in from the
bound context when the caller left it `undefined` — so each one's create paths
were walked. This is where the org comes from in each:

| Model | `orgId` | Where a new row's org comes from |
|---|---|---|
| `Tag` | required | `POST /api/tags` — wrapped, passes `resolveOrgId(session)` explicitly. |
| `StageSla` | required | `PUT /api/admin/stage-sla` — wrapped; the `upsert`'s natural key is `(orgId, stageKey)`, so the org is named in both `where` and `create`. |
| `PipelineStage` | required | `PUT /api/admin/organizations/[id]/pipeline-stages` — **deliberately not wrapped**: a super admin manages any tenant (#1535) and the org is a path parameter. Every query names `orgId: id` itself. |
| `EvaluationTemplate` | required | `PUT /api/admin/evaluation-templates` — wrapped in #1559; the create names `resolveOrgId(session)`. |
| `InterviewPanel` | nullable | `POST /api/interview-panels` — wrapped; the create stamps the **subject's** own org, falling back to the caller's. |
| `Offer` | nullable | `POST /api/offers` — wrapped; the create inherits `relation.orgId`, and with the flag on that relation's own lookup is already scoped, so a foreign relation reads as "not found" and never reaches the create. |
| `InvitationToken` | nullable | `src/lib/inviteCreate.ts` (the single minting path, called by `/api/invite` and the bulk route) — passes the inviter's `resolveOrgId(session)`. |
| `CompanyInquiry` | nullable | `POST /api/company-inquiry` — **public, no session**; it stamps `defaultOrgId()` itself (see below). |

Writes that happen **outside a request**, where no context is bound and the
middleware never engages, so each binds its own org:

- **the offer-expiry cron** (`expireOffers()` in `src/lib/offerNotify.ts`, run
  from `/api/cron`) sweeps **every** tenant's due offers and claims each row with
  `status: 'SENT'` rather than a tenant filter. That is the required behaviour —
  one tick must expire every org's offers, and there is no session to resolve an
  org from;
- **the deploy backfills** (`prisma/backfill-organization.mjs`,
  `prisma/backfill-relation-start-stage.mjs`) run as plain Node scripts that
  never load `orgContext.ts`, so no middleware exists in that process at all;
  they read and write `orgId` explicitly, which is their whole job;
- **`prisma/seed.mjs` / `seed-demo.mjs` / `scripts/sanitize-db.mjs`** — same.

Three **sessionless read paths** are deliberately left unwrapped, and each now
says so in a comment so nobody "fixes" it later. With no context bound the
middleware early-returns, which is exactly what keeps them working once the flag
is on:

- `POST /api/register` looks the invitation up **by token** — the only thing the
  invitee holds — and the row's own `orgId` is what assigns the new account its
  tenant (#1272);
- `POST /api/invite/opened` stamps `openedAt`, also by token;
- `POST /api/auth/verify-email` advances the matching invitation by **address**.

Wrapping any of those would narrow the lookup to an org the invitee cannot
present, and the invitation would become unusable to the person it was sent to.

**Why the public company enquiry stamps an org instead of staying NULL.** The
`/for-companies` form has no session, and there is no host/subdomain→org
resolution yet (`resolveOrgId` reads the session and nothing else), so the
enquiry carries no tenant signal. The admin triage list
(`/api/admin/company-inquiries`) runs inside `withTenantScope`, so a `NULL`-org
row would match no tenant and **disappear from the only screen that shows it** —
the failure mode step 1 of the rollout checklist below is about. The submit
therefore calls `defaultOrgId()`, the same thing `/api/register` does for an
uninvited sign-up. When host-based tenancy lands, that line is where the real
tenant gets resolved.

**Hand-written filters were kept, not removed**, everywhere the flag being off
leaves them as the only protection — the admin invitation board, the bulk
invitation actions, the tag routes, `assertSameOrg` on the interview-panel
lookups. They all read the same `resolveOrgId(session)` the middleware would
inject, so the two can never disagree. The one filter that *was* removed is the
admin offer list's, which was gated on `isIsolationEnforced()` — i.e. it applied
exactly when and how the middleware already does, which is two sources of truth
for one filter.

The proof is `e2e/tenant-models-registered.spec.ts`: for each of the eight, a
`findMany` with **no** tenant filter of its own, run against the app's Prisma
client inside `runWithOrg()`, in both directions. That is the only assertion that
separates "the middleware scoped it" from "the handler happened to filter" — a
route response cannot tell you which. A third test is the control: with the flag
off the same reads return both tenants' rows, so a half-written seed cannot make
the file pass while testing nothing.

`MT_ENFORCE_ISOLATION` itself is **not** flipped by #1559 — that is #1572, after
the rollout checklist below.

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
acceptance, the `/for-companies` enquiry) are intentionally not wrapped: they
have no session and resolve their subject from the invite/reset token or the
address typed into the form, not a tenant context. Routes that only ever read
the caller's own rows (account, profile, avatar, cv) are wrapped too for
uniformity, though scoping is redundant there.

One **authenticated** route is deliberately unwrapped as well:
`/api/admin/organizations/[id]/pipeline-stages`, where the org is a path
parameter because a super admin manages any tenant (#1535). Binding the caller's
own org there would narrow every query to the wrong tenant and break the feature;
`requireAdminOrg()` is what refuses a plain ADMIN a foreign `id`, and every query
names `orgId: id` itself.

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
