// Tenant and world fragments for the analytics reads (#2542 pattern, leak audit WP3).
//
// WHY THIS EXISTS
//   The analytics routes run inside `withTenantScope()`, which does nothing
//   while MT_ENFORCE_ISOLATION is off — every deployment today. Their groupBys
//   and counts therefore summed every organization on the database: a MARKETING
//   admin's funnel, meeting count and signup numbers included the INTERNSHIP
//   product's rows, and the aging report listed its candidates by name. Each
//   route now ANDs the caller's tenant in by hand (`tenantWhere()` +
//   `withinTenant()`, src/lib/tenantFilter.ts); this file holds the fragments
//   for the models that carry no `orgId` of their own and are reached through a
//   parent, so that "which parent decides" is written once.
//
// PURE: no Prisma client, no server import — unit-tested in
// scripts/test/analytics-scope.test.mjs.

import type { Prisma } from '@prisma/client';
import type { TenantWhere } from '@/lib/tenantFilter';
import { DEFAULT_VERTICAL, VERTICAL_KEYS, toVerticalKey, type VerticalKey } from '@/lib/verticals';

const isEmpty = (tenant: TenantWhere) => Object.keys(tenant).length === 0;

/**
 * `InteractionLog` has no `orgId`: it belongs to its relation's tenant.
 * `{}` only for the no-session fragment, which every caller has rejected.
 */
export function interactionInTenant(tenant: TenantWhere): Prisma.InteractionLogWhereInput {
  return isEmpty(tenant) ? {} : { relation: { is: tenant } };
}

/**
 * `Meeting` has no `orgId`: a relation meeting belongs to its relation's
 * tenant, a project meeting to its project's. A conversation-only meeting has
 * neither and is never counted — there is no tenant it could be attributed to
 * without guessing, and a guess is how a foreign row gets in.
 */
export function meetingInTenant(tenant: TenantWhere): Prisma.MeetingWhereInput {
  if (isEmpty(tenant)) return {};
  return { OR: [{ relation: { is: tenant } }, { project: { is: tenant } }] };
}

/**
 * A `where` on a model with an `org` relation, narrowed to the organizations of
 * one WORLD (docs/worlds.md). The default world is every org that is not in
 * another vertical — including a row with no org at all, which the deploy
 * backfill gives to the default org — the same rule `worldUserWhere()` applies
 * to users. Used by the cross-program benchmark, whose peer pool must never mix
 * the two products.
 */
export function orgInWorldWhere(world: VerticalKey): Prisma.MentorshipRelationWhereInput {
  const w = toVerticalKey(world);
  if (w !== DEFAULT_VERTICAL) return { org: { is: { vertical: w } } };
  const others = VERTICAL_KEYS.filter((k) => k !== DEFAULT_VERTICAL);
  return others.length ? { NOT: { org: { is: { vertical: { in: others } } } } } : {};
}

/**
 * The benchmark's per-program key for a grouped row. A NULL `orgId` is the
 * default org's row (the backfill rule), so it is folded into that program
 * rather than counted as an anonymous extra "program" of its own.
 */
export function benchmarkOrgKey(rowOrgId: string | null | undefined, defaultOrgId: string): string {
  return rowOrgId ?? defaultOrgId;
}
