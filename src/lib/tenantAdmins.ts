// The active ADMINs of one organization — the only way a route or cron picks
// "the admins" to notify (#2542). The rule and its reasoning live in
// src/lib/tenantAdminsRule.ts; this is the Prisma-aware half.
//
// Never write `prisma.user.findMany({ where: { role: 'ADMIN' } })` for a
// recipient list again: with the tenant middleware dormant that is every
// tenant's admins, i.e. one product's sign-ups in the other product's bell.
//
// SERVER-ONLY: touches Prisma.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { defaultOrgId } from '@/lib/defaultOrg';
import { groupByOrg, tenantAdminWhereFor } from '@/lib/tenantAdminsRule';

/** `where` for the active ADMINs of the org `orgId` (NULL = the default org). */
export async function tenantAdminWhere(orgId: string | null | undefined): Promise<Prisma.UserWhereInput> {
  return tenantAdminWhereFor(orgId, await defaultOrgId());
}

/** Ids of the active ADMINs of exactly that org — the bell fan-out recipients. */
export async function tenantAdminIds(orgId: string | null | undefined): Promise<string[]> {
  const admins = await prisma.user.findMany({ where: await tenantAdminWhere(orgId), select: { id: true } });
  return admins.map((a) => a.id);
}

/** Every active ADMIN, grouped by the org they administer (NULL → default). */
export async function activeAdminsByOrg<S extends Prisma.UserSelect & { orgId: true }>(
  select: S,
): Promise<Map<string, Prisma.UserGetPayload<{ select: S }>[]>> {
  const rows = (await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select,
  })) as unknown as (Prisma.UserGetPayload<{ select: S }> & { orgId: string | null })[];
  return groupByOrg(rows, await defaultOrgId());
}
