// Tenant (org) scoping helpers for multi-tenancy enforcement (#543).
//
// Phase-1 of MT was additive: every tenant-scoped row carries a nullable orgId
// backfilled to a single "default" org, and NOTHING filters by it — so the live
// single-tenant app is unchanged. This module is the *enforcement building
// block*: an explicit, opt-in way to scope a query to one tenant, plus the guard
// that decides whether global enforcement is on.
//
// It deliberately does NOT install a global Prisma middleware that auto-injects
// orgId into every query. That flip must not happen on a live single-tenant prod
// until (a) request→org resolution is plumbed everywhere and (b) it is exercised
// end-to-end by the isolation test with a real DB. Until then callers opt in via
// orgScoped()/assertSameOrg(), and MT_ENFORCE_ISOLATION stays off.
//
// See docs/tenant-isolation.md for the turn-it-on checklist.

import type { Session } from 'next-auth';

// Is global tenant isolation enforcement switched on for this deployment?
// Defaults OFF. A single env flag so the rollout is reversible and observable.
export function isIsolationEnforced(): boolean {
  return process.env.MT_ENFORCE_ISOLATION === 'true';
}

// Resolve the org a request belongs to. Today that is simply the signed-in
// user's orgId (added in #543 phase 1). When host/subdomain-based tenancy lands
// this is where that resolution goes. Null when unknown (e.g. public routes or a
// user not yet assigned to an org).
export function resolveOrgId(session: Session | null | undefined): string | null {
  const orgId = (session?.user as { orgId?: string | null } | undefined)?.orgId;
  return orgId ?? null;
}

// Merge an orgId filter into a Prisma `where`. The building block enforcement
// consumers use: `prisma.user.findMany({ where: orgScoped(where, orgId) })`.
// A null orgId returns the where unchanged (no scoping) — callers that must
// enforce should check `requireOrg` first.
export function orgScoped<W extends Record<string, unknown>>(
  where: W | undefined,
  orgId: string | null,
): W & { orgId?: string } {
  if (!orgId) return (where ?? {}) as W & { orgId?: string };
  return { ...(where ?? {}), orgId } as W & { orgId?: string };
}

// Guard for write/read handlers that must be tenant-scoped once enforcement is
// on. Returns the orgId to scope by, or throws when enforcement is on but no org
// resolves (fail-closed). When enforcement is off it returns the resolved orgId
// (possibly null) so callers behave exactly as before.
export function requireOrg(session: Session | null | undefined): string | null {
  const orgId = resolveOrgId(session);
  if (isIsolationEnforced() && !orgId) {
    throw new Error('Tenant isolation is enforced but no organization resolved for this request');
  }
  return orgId;
}

// Assert a fetched row belongs to the expected tenant. Use after a lookup by id
// to prevent cross-tenant access (IDOR) once enforcement is on. No-op when
// enforcement is off or the expected org is unknown.
export function assertSameOrg(rowOrgId: string | null | undefined, expectedOrgId: string | null): void {
  if (!isIsolationEnforced() || !expectedOrgId) return;
  if (rowOrgId !== expectedOrgId) {
    throw new Error('Cross-tenant access denied');
  }
}

// ── The org boundary that holds while the middleware is still dormant (#2542) ─
//
// `assertSameOrg` above is a no-op unless MT_ENFORCE_ISOLATION is on, which was
// right while there was ONE tenant. There are now two products in one database
// (INTERNSHIP and MARKETING, epic #2348), and the flag is not yet safe to flip
// (docs/tenant-isolation.md — the #2542 audit found 56 cross-tenant reads and
// writes, most of them on models the middleware cannot scope at all because
// they carry no orgId and are reached through a parent).
//
// So a fetch-by-id of such a child row resolves its PARENT's org and asks this.
// It is deliberately NOT gated on the flag: an admin of org B reading org A's
// interaction notes is wrong today, not only after the flip.
//
// It is the one-row form of `tenantWhere()` (src/lib/tenantFilter.ts), and it
// reads "unknown" by the same rule: a row whose org is still NULL, and a
// signed-in session without an org, both belong to the DEFAULT org — the rule
// `prisma/backfill-organization.mjs` applies on every deploy. Reading an
// org-less side as "anything goes" would fail OPEN: a 12h JWT minted before the
// backfill stamped its user would reach every tenant's rows. The default org's
// single-tenant state is unchanged by construction: all of it is one tenant.
//
// Pure (the default org's id is passed in) so it is unit-testable; route code
// calls `inCallerTenant()` in tenantFilter.ts, which supplies it. Callers answer
// a mismatch with 404, never 403: a 403 would confirm the id exists.
export function sameTenant(
  rowOrgId: string | null | undefined,
  callerOrgId: string | null | undefined,
  defaultOrgId: string,
): boolean {
  return (rowOrgId || defaultOrgId) === (callerOrgId || defaultOrgId);
}
