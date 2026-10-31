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
import { effectiveOrgId, groupByOrg, tenantAdminWhereFor } from '@/lib/tenantAdminsRule';
import { adminReceives, ORG_LEVEL_ADMIN_WHERE, type NoticeSubject } from '@/lib/programScopeRule';

// The pure module spells the tier column as plain strings; Prisma types it as the enum.
const ORG_LEVEL = ORG_LEVEL_ADMIN_WHERE as Prisma.UserWhereInput;

/**
 * `where` for the active ADMINs of the org `orgId` (NULL = the default org) who
 * receive ORG-LEVEL notices: ORG_ADMIN (or an empty tier column) and OBSERVER.
 * A PROGRAM_ADMIN hears only about subjects its grants cover (#3485) — pass a
 * subject to tenantAdminIds() / tenantAdminRows() for that.
 */
export async function tenantAdminWhere(orgId: string | null | undefined): Promise<Prisma.UserWhereInput> {
  return { AND: [tenantAdminWhereFor(orgId, await defaultOrgId()), ORG_LEVEL] };
}

/**
 * The org's admins who hear about `subject` (#3485, programScopeRule.ts
 * `adminReceives`): every org-level admin, plus each active PROGRAM_ADMIN with
 * a grant (of this org) covering it. `subject` null or omitted = an org-level
 * notice: no PROGRAM_ADMIN.
 */
export async function tenantAdminRows<S extends Prisma.UserSelect & { id: true }>(
  orgId: string | null | undefined,
  subject: NoticeSubject | null,
  select: S,
): Promise<Prisma.UserGetPayload<{ select: S }>[]> {
  const fallback = await defaultOrgId();
  const orgFilter = tenantAdminWhereFor(orgId, fallback);
  const orgLevel = (await prisma.user.findMany({
    where: { AND: [orgFilter, ORG_LEVEL] },
    select,
  })) as unknown as Prisma.UserGetPayload<{ select: S }>[];
  if (!subject || (!subject.cohortId && !subject.companyId)) return orgLevel;
  const programAdmins = (await prisma.user.findMany({
    where: { AND: [orgFilter, { adminLevel: 'PROGRAM_ADMIN' }] },
    select,
  })) as unknown as Prisma.UserGetPayload<{ select: S }>[];
  if (programAdmins.length === 0) return orgLevel;
  const org = effectiveOrgId(orgId, fallback);
  const grants = await prisma.adminScopeGrant.findMany({
    where: { orgId: org, userId: { in: programAdmins.map((a) => (a as { id: string }).id) } },
    select: { userId: true, cohortId: true, companyId: true },
  });
  const covered = programAdmins.filter((a) =>
    adminReceives('PROGRAM_ADMIN', grants.filter((g) => g.userId === (a as { id: string }).id), subject),
  );
  return [...orgLevel, ...covered];
}

/** Ids of the org's admins who hear about `subject` (null = an org-level notice) — the bell fan-out recipients. */
export async function tenantAdminIds(orgId: string | null | undefined, subject: NoticeSubject | null = null): Promise<string[]> {
  return (await tenantAdminRows(orgId, subject, { id: true })).map((a) => a.id);
}

/**
 * Every active ADMIN, grouped by the org they administer (NULL → default).
 * Org-level recipients only, unless `includeProgramAdmins` — then the caller
 * narrows each PROGRAM_ADMIN's content itself (programGrantsFor()), as the
 * daily activity digest does.
 */
export async function activeAdminsByOrg<S extends Prisma.UserSelect & { orgId: true }>(
  select: S,
  opts: { includeProgramAdmins?: boolean } = {},
): Promise<Map<string, Prisma.UserGetPayload<{ select: S }>[]>> {
  const rows = (await prisma.user.findMany({
    where: opts.includeProgramAdmins
      ? { role: 'ADMIN', isActive: true }
      : { AND: [{ role: 'ADMIN', isActive: true }, ORG_LEVEL] },
    select,
  })) as unknown as (Prisma.UserGetPayload<{ select: S }> & { orgId: string | null })[];
  return groupByOrg(rows, await defaultOrgId());
}
