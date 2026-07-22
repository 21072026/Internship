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

const globalForPrisma = globalThis as unknown as { tenantMiddlewareInstalled?: boolean };

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
  return storage.run({ orgId }, fn);
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
