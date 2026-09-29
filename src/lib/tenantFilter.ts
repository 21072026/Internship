// The caller's own tenant as a Prisma `where` fragment, independent of
// MT_ENFORCE_ISOLATION (#2542).
//
// WHY THIS EXISTS
//   The central middleware (src/lib/orgContext.ts) only engages with the flag
//   on, which it is in no deployment today. That was harmless while one
//   `default` org held everything; since the MARKETING vertical became a second
//   real tenant on the same database, an admin's user list, candidate book and
//   company book returned the other product's rows, and its records opened by
//   id. The routes that read those rows therefore filter by hand — the pattern
//   docs/tenant-isolation.md § "Hand-written filters were kept" describes — and
//   this is the one place that decides what "the caller's tenant" means there.
//
// THE ONE DIFFERENCE FROM `orgScoped()`
//   A row whose `orgId` is still NULL belongs to the DEFAULT org: that is the
//   rule `prisma/backfill-organization.mjs` applies on every deploy, and a row
//   can sit NULL until the next one (a create path that relies on the dormant
//   middleware to stamp it, a fixture, a legacy import). A strict
//   `orgId = <default>` filter would make such a row vanish from the only
//   screens that list it — the failure mode step 1 of the rollout checklist is
//   about — so the default org's admins also match `orgId IS NULL`. Every other
//   org matches its own id and nothing else, so a NULL row is never visible to
//   a non-default tenant. Once the backfill runs green and #1572 turns the
//   middleware on, there are no NULL rows left and this is the same filter the
//   middleware injects.
//
//   A session with no org resolves to `{}` — unscoped, exactly as before —
//   which is `orgScoped()`'s rule too.
//
// SERVER-ONLY: `defaultOrgId()` touches Prisma (cached after the first call).

import type { Session } from 'next-auth';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';

export type TenantWhere = { orgId: string } | { OR: [{ orgId: string }, { orgId: null }] } | Record<string, never>;

/** The caller's tenant as a `where` fragment; `{}` when the session has no org. */
export async function tenantWhere(session: Session | null | undefined): Promise<TenantWhere> {
  const orgId = resolveOrgId(session);
  if (!orgId) return {};
  if (orgId === (await defaultOrgId())) return { OR: [{ orgId }, { orgId: null }] };
  return { orgId };
}

/**
 * `where` narrowed to the tenant, as a conjunct. `AND` rather than a spread so
 * the fragment's own `OR` can never replace — or be replaced by — a caller's
 * `OR` (the #2288 lesson, see `andScope` in src/lib/authzScope.ts).
 */
export function withinTenant<W extends object>(where: W, tenant: TenantWhere): W {
  if (Object.keys(tenant).length === 0) return where;
  if (Object.keys(where).length === 0) return { ...tenant } as unknown as W;
  return { AND: [where, tenant] } as unknown as W;
}
