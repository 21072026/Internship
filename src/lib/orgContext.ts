// Request-scoped tenant (org) context + central enforcement for multi-tenancy
// (#543).
//
// The primitives in `orgScope.ts` are explicit and opt-in — a caller must
// remember to wrap each `where` with `orgScoped()`. That is easy to forget, and
// the acceptance criterion for #543 is that *every* tenant-scoped query is
// isolated. This module closes that gap:
//
//   1. It carries the current request's orgId in an AsyncLocalStorage.
//   2. It installs ONE Prisma middleware that auto-scopes every query on a
//      tenant-anchored model to that orgId — the "can't forget the filter"
//      guarantee behind the guarded MT_ENFORCE_ISOLATION rollout.
//
// It stays completely dormant unless `MT_ENFORCE_ISOLATION=true`: `runWithOrg`
// is a plain passthrough when enforcement is off, no context is established, and
// the middleware early-returns — so single-tenant production pays nothing and
// behaves exactly as before.
//
// This is SERVER-ONLY (it imports node:async_hooks). It must never enter a
// client bundle, which is why the enforcement lives here rather than in the
// widely-imported prisma.ts. Only server route handlers call withTenantScope().

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Session } from 'next-auth';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { isIsolationEnforced, resolveOrgId } from './orgScope';
import { registerTenantAmbient } from './tenantAmbient';

// The value carried per request: the tenant id to scope to (or null when the
// request has no resolvable org — e.g. an unauthenticated/public route).
const storage = new AsyncLocalStorage<{ orgId: string | null }>();

// The orgId bound to the current async context, or undefined when there is none.
// `undefined` means "no context — do not scope"; an explicit `null` means
// "context present but no org".
export function currentOrgId(): string | null | undefined {
  return storage.getStore()?.orgId;
}

// ── Central enforcement middleware ───────────────────────────────────────────
// Models that carry a nullable `orgId` (the tenant anchors). Child records
// (InteractionLog, Message, Goal, …) are reached through these scoped parents.
const TENANT_MODELS: ReadonlySet<Prisma.ModelName> = new Set([
  'User',
  'Source',
  'Company',
  'Project',
  'Cohort',
  'MentorshipRelation',
  'MentorApplication',
  'DocumentRequirement',
  'WeeklyReport',
  'Requisition',
  'InterviewRequest',
  'MessageTemplate',
  // Brute-force lockouts (#1541). Rows are written by the sign-in path, which
  // runs outside any tenant scope (there is no session yet) and stamps orgId
  // itself; listing this here is what keeps one tenant's admin from seeing or
  // clearing another tenant's lockouts.
  'AccountLockout',
  // Programmatic credentials are tenant property too (#1466): a key minted in
  // one org must never be listed by — or authenticate into — another.
  'ApiKey',
  'MatchFeedback',
  // Queued background work (#1674). A job's payload belongs to whichever tenant
  // enqueued it, so the row carries orgId and is listed here. The operational
  // readers — /api/health's counters and the daily dead-letter alert — run
  // outside any request scope, where the middleware does not engage, so they
  // still see the whole queue.
  'Job',
  // Product settings (#1553). Registered so that any code touching
  // `prisma.setting` directly can only ever see its own tenant's rows. The
  // settings readers/writers in src/lib/settings.ts deliberately opt OUT (they
  // run inside `runWithOrg(null, …)`), because the org → GLOBAL (orgId = NULL)
  // → code-default fallback chain needs to read a row this filter would hide;
  // they compute the org themselves from the bound context instead.
  'Setting',
  // Programme economics (#1892). What a tenant spends and what a placement was
  // worth is among the most commercially sensitive data in the product — one
  // org must never be able to read, let alone edit, another's cost lines or
  // fee figures. Both carry a REQUIRED orgId, so unlike the phase-1 models
  // there is no null-org fallback row to reason about.
  'ProgramCost',
  'Placement',
  // The commercial spine (#1731). What a tenant pays for, and every feature
  // granted to it outside its plan. Both carry a REQUIRED orgId. Reading
  // another tenant's subscription would leak its plan, its trial and its
  // discount; writing one would change what somebody else is billed — so
  // these are registered from the moment the tables exist, before anything
  // reads them.
  'Subscription',
  'OrgEntitlement',
  // What a tenant used, per calendar month (#1750). The numbers an invoice is
  // built from — one org reading another's usage is a commercial leak, and one
  // org *writing* it would be a billing dispute. REQUIRED orgId, so there is no
  // null-org fallback row here either. The nightly rollup runs outside any
  // request scope, where the middleware does not engage, so it still sees every
  // tenant.
  'UsageRollup',
  // The notification delivery ledger (#1710). One row per (recipient, event,
  // channel) — who was told what, and why they were not. It is written by the
  // router from whatever context the caller happens to be in (a request, a
  // cron), and stamps `orgId` from the recipient's own User row rather than
  // relying on the middleware, so the row is right either way; the registration
  // is what keeps every *reader* of the ledger scoped to its own tenant.
  'NotificationDelivery',
  // The scheduled roster feed (#1965). A feed carries a tenant's HR export and
  // its runs carry, row by row, who is in that tenant's roster — so all three
  // are tenant property. Registered rather than exempt even though the ingest
  // binds its own org explicitly with `runWithOrg(feed.orgId, …)` (a cron job
  // has no session to resolve one from): the explicit binding is what makes the
  // *background* run scoped, and the registration is what keeps every other
  // reader — an admin screen listing runs, a support query — inside its own
  // tenant.
  'RosterFeed',
  'RosterRun',
  'RosterRowResult',
]);

// Actions whose `where` selects rows to read or mutate — inject orgId there.
// findUnique/update/delete accept extra non-unique filters in Prisma 5
// (extendedWhereUnique), so adding orgId narrows them safely.
const WHERE_ACTIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

function mergeOrgWhere(where: unknown, orgId: string): Record<string, unknown> {
  return where && typeof where === 'object'
    ? { ...(where as Record<string, unknown>), orgId }
    : { orgId };
}

const globalForPrisma = globalThis as unknown as {
  tenantMiddlewareInstalled?: boolean;
  apiKeyOrgGuardInstalled?: boolean;
};

// Register the auto-scoping middleware exactly once on the prisma singleton.
// Called lazily from runWithOrg (only when enforcement is on), so the middleware
// exists before any scoped query runs. Idempotent across dev hot-reloads.
function ensureTenantMiddleware(): void {
  if (globalForPrisma.tenantMiddlewareInstalled) return;
  globalForPrisma.tenantMiddlewareInstalled = true;

  prisma.$use(async (params, next) => {
    if (!isIsolationEnforced()) return next(params);
    const orgId = currentOrgId();
    // No bound context (undefined) or no org (null) → do not scope. Until a
    // route opts in via withTenantScope it is simply unenforced, never leaking
    // more than the single-tenant app already does.
    if (!orgId) return next(params);
    if (!params.model || !TENANT_MODELS.has(params.model)) return next(params);

    const action = params.action as string;
    const args = (params.args ?? {}) as Record<string, unknown>;

    if (WHERE_ACTIONS.has(action)) {
      args.where = mergeOrgWhere(args.where, orgId);
    } else if (action === 'create') {
      const data = (args.data ?? {}) as Record<string, unknown>;
      if (data.orgId === undefined) data.orgId = orgId;
      args.data = data;
    } else if (action === 'createMany') {
      const data = args.data;
      if (Array.isArray(data)) {
        args.data = data.map((row) => {
          const r = (row ?? {}) as Record<string, unknown>;
          if (r.orgId === undefined) r.orgId = orgId;
          return r;
        });
      }
    } else if (action === 'upsert') {
      args.where = mergeOrgWhere(args.where, orgId);
      const create = (args.create ?? {}) as Record<string, unknown>;
      if (create.orgId === undefined) create.orgId = orgId;
      args.create = create;
    }

    params.args = args;
    return next(params);
  });
}

// Run `fn` with the given org bound as the current tenant context, so every
// Prisma query inside is auto-scoped. When enforcement is off this is a straight
// passthrough (no context, no middleware activity) — the single-tenant app is
// unchanged.
export function runWithOrg<T>(orgId: string | null, fn: () => T): T {
  if (!isIsolationEnforced()) return fn();
  ensureTenantMiddleware();
  return storage.run({ orgId }, () => {
    const result = fn();
    // Prisma's query promises are LAZY: the request — and therefore the
    // middleware above — only fires on the first .then() subscription. When a
    // caller writes `runWithOrg(org, () => prisma.x.findMany())` and awaits
    // OUTSIDE, that subscription would happen outside this context and the
    // middleware would silently skip scoping (#958). Subscribing here forces
    // any lazy thenable to start inside the bound context.
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return new Promise((resolve, reject) => {
        (result as unknown as PromiseLike<unknown>).then(resolve, reject);
      }) as T;
    }
    return result;
  });
}

// ── API-key requests (#1546) ────────────────────────────────────────────────
// A request authenticated by an API key carries no session, so `resolveOrgId`
// has nothing to read and `currentOrgId()` stays `undefined` — which is exactly
// the state the middleware above treats as "no context, do not scope". That is
// how `/api/v1/candidates` came to read every organisation's mentees while
// looking perfectly ordinary: nothing was missing from the query, the tenant
// context simply never existed.
//
// These three helpers make that absence loud. They are deliberately INDEPENDENT
// of `MT_ENFORCE_ISOLATION`: the flag being off is precisely when a missing
// tenant context is silent, so the guard must not be off with it.
const apiKeyRequestStorage = new AsyncLocalStorage<{ orgId: string | null }>();

// Mark the current async context as "serving an API-key-authenticated request,
// org not yet resolved". `withApiKey()` (src/lib/apiKey.ts) enters this BEFORE
// looking the key up, so everything the request does afterwards is inside it.
export function runAsApiKeyRequest<T>(fn: () => Promise<T>): Promise<T> {
  ensureApiKeyOrgGuard();
  return apiKeyRequestStorage.run({ orgId: null }, fn);
}

// Bind the key's organisation for the rest of the request: the marker records
// it (so the dev guard below stops firing) and `runWithOrg` gives the Prisma
// middleware the same tenant context a session-authenticated route has.
export function runWithApiKeyOrg<T>(orgId: string, fn: () => T): T {
  const store = apiKeyRequestStorage.getStore();
  if (!store) assertApiKeyRequestContext('runWithApiKeyOrg');
  else store.orgId = orgId;
  return runWithOrg(orgId, fn);
}

// Loud in development, logged in production: authenticating by API key outside
// `withApiKey()` means whatever the handler reads next is unscoped.
export function assertApiKeyRequestContext(caller: string): void {
  if (apiKeyRequestStorage.getStore()) return;
  const message =
    `${caller} ran outside runAsApiKeyRequest(): an API-key request must establish a tenant ` +
    'context before it reads anything. Route it through withApiKey() in src/lib/apiKey.ts (#1546).';
  if (process.env.NODE_ENV === 'production') {
    console.error(message);
    return;
  }
  throw new Error(message);
}

// The runtime half of the guard: while an API-key request has no organisation
// bound, a query on a tenant-anchored model would read every tenant's rows. In
// development that throws instead. `ApiKey` itself is exempt — the key lookup
// and its `lastUsedAt` stamp are what resolve the org in the first place.
function ensureApiKeyOrgGuard(): void {
  if (process.env.NODE_ENV === 'production') return;
  if (globalForPrisma.apiKeyOrgGuardInstalled) return;
  globalForPrisma.apiKeyOrgGuardInstalled = true;

  prisma.$use(async (params, next) => {
    const store = apiKeyRequestStorage.getStore();
    if (store && !store.orgId && params.model && params.model !== 'ApiKey' && TENANT_MODELS.has(params.model)) {
      throw new Error(
        `prisma.${params.model}.${params.action}() ran in an API-key request with no organisation ` +
          'bound — it would read every tenant. Run the handler inside runWithApiKeyOrg() (#1546).',
      );
    }
    return next(params);
  });
}

// Convenience wrapper for API route handlers: resolve the request's org from the
// session and run the handler with that tenant context bound.
//
//   export async function GET() {
//     const session = await getServerSession(authOptions);
//     return withTenantScope(session, async () => { ...existing handler... });
//   }
export function withTenantScope<T>(session: Session | null | undefined, fn: () => T): T {
  return runWithOrg(resolveOrgId(session), fn);
}

// Publish this engine to the client-safe seam (src/lib/tenantAmbient.ts) so
// modules that must not import THIS file — it pulls in node:async_hooks, which
// webpack refuses to bundle for a client graph — can still read the bound org
// and run a query outside the tenant filter. `src/lib/settings.ts` is the one
// that needs both; see the header there. Evaluating this module is what
// registers it, and any request that binds a tenant has evaluated it, because
// `withTenantScope` above is how the binding happens.
registerTenantAmbient({
  currentOrgId,
  runUnscoped: (fn) => runWithOrg(null, fn),
});
