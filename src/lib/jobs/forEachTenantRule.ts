// Which tenant passes a background sweep makes (#1561). Dependency-free so the
// rule is unit-tested under `node --test` (scripts/test/for-each-tenant.test.mjs);
// the Prisma-aware runner is src/lib/jobs/forEachTenant.ts.
//
// A pass is an org id to bind with runWithOrg(), or `null` for ONE unscoped pass.
//
// THE RULE
//   Isolation enforced (MT_ENFORCE_ISOLATION) → one pass per organization, in a
//     stable order, each id once. The middleware scopes every tenant-model query
//     inside the pass to that org, so the sweep touches that tenant's rows only.
//   Isolation off → ONE unscoped pass, exactly what every sweep does today. With
//     the flag off nothing scopes a query, so N per-org passes of a sweep that
//     relies on the middleware would each read EVERY tenant's rows — N reminders
//     for one overdue mentee. Byte-for-byte today's recipient set is the
//     acceptance criterion (#1561), and one pass is the only way to keep it.
//   `perOrgWhenUnenforced` → per-org passes even with the flag off. Only for a
//     sweep that filters by `currentOrgId()` itself (or reads a per-tenant
//     setting through the bound org) — never for one that relies on the
//     middleware to narrow its reads.
//   No organizations at all (a fresh database) → one unscoped pass, so a sweep
//     over legacy org-less rows still runs.

export interface TenantPlanInput {
  enforced: boolean;
  orgIds: readonly string[];
  perOrgWhenUnenforced?: boolean;
}

export function tenantPasses({ enforced, orgIds, perOrgWhenUnenforced = false }: TenantPlanInput): (string | null)[] {
  if (!enforced && !perOrgWhenUnenforced) return [null];
  const ids = [...new Set(orgIds.filter((id) => typeof id === 'string' && id !== ''))].sort();
  return ids.length ? ids : [null];
}

/** A failure message that is safe to log: the class and message, never a stack
 *  or a payload — a sweep's error can echo the row it was working on. */
export function passFailure(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 500);
  return String(e).slice(0, 500);
}
