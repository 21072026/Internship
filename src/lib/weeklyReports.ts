import { prisma } from '@/lib/prisma';

export const SUBMITTED_WEEKLY_REPORT_STATUSES = ['SUBMITTED', 'APPROVED', 'CHANGES_REQUESTED'] as const;

export interface WeeklyReportViewer {
  id: string;
  role: string;
}

export async function weeklyReportRelation(relationId: string) {
  return prisma.mentorshipRelation.findUnique({
    where: { id: relationId },
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

export function canReadWeeklyReports(viewer: WeeklyReportViewer, relation: { mentorId: string; menteeId: string }): boolean {
  return viewer.role === 'ADMIN' || relation.mentorId === viewer.id || relation.menteeId === viewer.id;
}

export function reportOrganizationId(relation: { orgId: string | null; mentee: { orgId: string | null } }): string | null {
  return relation.orgId ?? relation.mentee.orgId;
}
