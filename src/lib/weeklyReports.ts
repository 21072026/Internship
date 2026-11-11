import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';

export const SUBMITTED_WEEKLY_REPORT_STATUSES = ['SUBMITTED', 'APPROVED', 'CHANGES_REQUESTED'] as const;

export interface WeeklyReportViewer {
  id: string;
  role: string;
}

/**
 * The relation a weekly-report request names, inside the caller's tenant only
 * (#3588): `canReadWeeklyReports()` lets any ADMIN through, so the org has to be
 * decided here — the middleware that would narrow this lookup is off in every
 * deployment. Another org's relation reads as missing.
 */
export async function weeklyReportRelation(relationId: string, tenant: TenantWhere) {
  return prisma.mentorshipRelation.findFirst({
    where: withinTenant({ id: relationId }, tenant),
    select: {
      id: true,
      orgId: true,
      mentorId: true,
      menteeId: true,
      status: true,
      pipelineStatus: true,
      startDate: true,
      mentee: { select: { orgId: true, isActive: true, fullName: true, email: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true } },
    },
  });
}

/** Role and participation only — never the org. Pair it with a tenant-scoped lookup. */
export function canReadWeeklyReports(viewer: WeeklyReportViewer, relation: { mentorId: string; menteeId: string }): boolean {
  return viewer.role === 'ADMIN' || relation.mentorId === viewer.id || relation.menteeId === viewer.id;
}

export function reportOrganizationId(relation: { orgId: string | null; mentee: { orgId: string | null } }): string | null {
  return relation.orgId ?? relation.mentee.orgId;
}
