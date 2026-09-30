// Who "the admins" are, for exactly one organization — the pure half (#2542).
//
// WHY THIS EXISTS
//   Every "tell the admins" fan-out in the tree used to read
//   `prisma.user.findMany({ where: { role: 'ADMIN', isActive: true } })` — no
//   org at all. While one `default` org held everything that was the same
//   thing as "this tenant's admins"; since the MARKETING vertical became a
//   second real tenant on the same database, every INTERNSHIP sign-up, mentor
//   application and rematch landed in the MARKETING admins' bell too (and the
//   cron digests mailed one tenant's mentee names to the other's admins). The
//   tenant middleware cannot catch it — MT_ENFORCE_ISOLATION is off — so the
//   org is part of the query, always.
//
// THE RULE (the one tenantWhere()/orgWhere() in src/lib/tenantFilter.ts apply)
//   A NULL-org row belongs to the DEFAULT org — the rule the deploy backfill
//   applies. So the default org's admins also match `orgId IS NULL`, every
//   other org matches its own id and nothing else, and an unknown subject org
//   (NULL) is the default org's, never "every org".
//
// Dependency-free so it is unit-tested (scripts/test/tenant-admins.test.mjs);
// the Prisma-aware half is src/lib/tenantAdmins.ts.

export type AdminOrgFragment = { orgId: string } | { OR: [{ orgId: string }, { orgId: null }] };

export type TenantAdminWhere = {
  AND: [{ role: 'ADMIN'; isActive: true }, AdminOrgFragment];
};

/** The org a subject of `orgId` belongs to: NULL is the default org's. */
export function effectiveOrgId(orgId: string | null | undefined, defaultOrgId: string): string {
  return orgId || defaultOrgId;
}

/** `where` for the active ADMINs of exactly one org. */
export function tenantAdminWhereFor(orgId: string | null | undefined, defaultOrgId: string): TenantAdminWhere {
  const org = effectiveOrgId(orgId, defaultOrgId);
  const fragment: AdminOrgFragment = org === defaultOrgId ? { OR: [{ orgId: org }, { orgId: null }] } : { orgId: org };
  return { AND: [{ role: 'ADMIN', isActive: true }, fragment] };
}

/**
 * Split rows (recipients) by the org they belong to, NULL folded into the
 * default org. The cron digests use it to send each org its own figures.
 * Insertion order is kept, so output is deterministic for a deterministic input.
 */
export function groupByOrg<T extends { orgId: string | null }>(rows: readonly T[], defaultOrgId: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const org = effectiveOrgId(row.orgId, defaultOrgId);
    const bucket = out.get(org);
    if (bucket) bucket.push(row);
    else out.set(org, [row]);
  }
  return out;
}
