// Who a company may find in the talent pool (#528/#1392) — and therefore who it
// may ask to be introduced to from there (#1394). ONE rule, read by the search
// (GET /api/company/talent-pool) and by the introduction request
// (POST /api/company/outreach `via: 'TALENT_POOL'`), so a request can never
// reach a person the search would not have shown. Server-only.

import type { Prisma } from '@prisma/client';
import { hasFeature } from '@/lib/entitlements';
import { resolveSettingRaw } from '@/lib/settingsResolver';

/**
 * The fields a company sees of a pool candidate — the public-profile set the
 * candidate opted into. No e-mail, phone, address or birth date: contact
 * details reach a company only through an APPROVED introduction (#1394).
 */
export const TALENT_POOL_SELECT = {
  id: true,
  fullName: true,
  university: true,
  department: true,
  graduationYear: true,
  city: true,
  targetPosition: true,
  skills: true,
  avatarUrl: true,
} as const satisfies Prisma.UserSelect;

/**
 * Visibility = the caller's own org AND a public-profile opt-in AND an active TALENT_POOL_VISIBILITY
 * consent (#527) — revoking either removes the candidate at once — narrowed by
 * the early-access window (#531): a candidate who became hireable within the
 * last N days is visible only to a company holding EARLY_ACCESS (admins always
 * see everyone). Part of the WHERE, never a post-filter, so counts and pages stay right.
 */
export async function talentPoolVisibleWhere(input: {
  /** The caller's tenant — explicit, never left to the middleware (see below). */
  orgId: string | null;
  settingsOrgId: string | null;
  companyId: string | null | undefined;
  admin: boolean;
}): Promise<Prisma.UserWhereInput> {
  const where: Prisma.UserWhereInput = {
    // THE TENANT IS PART OF THE RULE (#1394). The tenant middleware only scopes
    // User reads under MT_ENFORCE_ISOLATION, so without this the pool showed
    // every org's opted-in candidates to any entitled company where that flag
    // is off. No org on the caller → nobody.
    orgId: input.orgId ?? '__no_org__',
    role: 'MENTEE',
    isActive: true,
    publicProfile: true,
    consents: { some: { type: 'TALENT_POOL_VISIBILITY', grantedAt: { not: null }, revokedAt: null } },
  };
  const windowDays = parseInt(await resolveSettingRaw('earlyAccessWindowDays', { orgId: input.settingsOrgId }), 10) || 0;
  const hasEarlyAccess = input.admin || (await hasFeature(input.companyId, 'EARLY_ACCESS'));
  if (windowDays > 0 && !hasEarlyAccess) {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    where.NOT = {
      menteeRelations: {
        some: { statusChanges: { some: { toStatus: 'HIREABLE_600', createdAt: { gte: cutoff } } } },
      },
    };
  }
  return where;
}
