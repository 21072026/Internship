import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { canReadWeeklyReports } from '@/lib/weeklyReports';
import { notify } from '@/lib/notify';
import { defaultLocale, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { notificationCategoryAllowed } from '@/lib/notificationPrefs';

const menteeSchema = z.object({
  summary: z.string().max(TEXT_LIMITS.weeklyReportSummary).optional(),
  hoursSpent: z.number().int().min(0).max(168).nullable().optional(),
  blockers: z.string().max(TEXT_LIMITS.weeklyReportBlockers).nullable().optional(),
  status: z.literal('SUBMITTED').optional(),
}).strict();
const mentorSchema = z.object({
  status: z.enum(['APPROVED', 'CHANGES_REQUESTED']),
  mentorComment: z.string().max(TEXT_LIMITS.weeklyReportMentorComment).nullable().optional(),
}).strict();

async function loadReport(id: string) {
  return prisma.weeklyReport.findUnique({
    where: { id },
    include: { relation: { select: { mentorId: true, menteeId: true, status: true, mentee: { select: { preferredLanguage: true, notificationPrefs: true } } } } },
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return withTenantScope(session, async () => {
    const report = await loadReport((await params).id);
    if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    if (!canReadWeeklyReports(session.user, report.relation)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return NextResponse.json({ report });
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role === 'ADMIN') return NextResponse.json({ error: 'Administrators have read-only access' }, { status: 403 });
  return withTenantScope(session, async () => {
    const report = await loadReport((await params).id);
    if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    if (report.relation.status !== 'ACTIVE') return NextResponse.json({ error: 'The mentorship is not active', code: 'inactive_relation' }, { status: 409 });

    if (session.user.role === 'MENTEE') {
      if (report.relation.menteeId !== session.user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      if (!['DRAFT', 'CHANGES_REQUESTED'].includes(report.status)) return NextResponse.json({ error: 'This report can no longer be edited', code: 'invalid_transition' }, { status: 409 });
      const parsed = menteeSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
      const summary = parsed.data.summary === undefined ? report.summary : parsed.data.summary.trim();
      if (parsed.data.status === 'SUBMITTED' && !summary) return NextResponse.json({ error: 'Summary is required before submission', code: 'summary_required' }, { status: 400 });
      const reportUpdate = await prisma.weeklyReport.update({
        where: { id: report.id },
        data: {
          ...(parsed.data.summary !== undefined ? { summary } : {}),
          ...(parsed.data.hoursSpent !== undefined ? { hoursSpent: parsed.data.hoursSpent } : {}),
          ...(parsed.data.blockers !== undefined ? { blockers: parsed.data.blockers?.trim() || null } : {}),
          ...(parsed.data.status ? { status: 'SUBMITTED' as const, mentorComment: null, reviewedById: null, reviewedAt: null } : {}),
        },
      });
      return NextResponse.json({ report: reportUpdate });
    }

    if (session.user.role !== 'MENTOR' || report.relation.mentorId !== session.user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (report.status !== 'SUBMITTED') return NextResponse.json({ error: 'Only submitted reports can be reviewed', code: 'invalid_transition' }, { status: 409 });
    const parsed = mentorSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    const mentorComment = parsed.data.mentorComment?.trim() || null;
    if (parsed.data.status === 'CHANGES_REQUESTED' && !mentorComment) return NextResponse.json({ error: 'A mentor comment is required when requesting changes', code: 'mentor_comment_required' }, { status: 400 });
    const transition = await prisma.weeklyReport.updateMany({
      where: { id: report.id, status: 'SUBMITTED', relation: { is: { status: 'ACTIVE', mentorId: session.user.id } } },
      data: { status: parsed.data.status, mentorComment, reviewedById: session.user.id, reviewedAt: new Date() },
    });
    if (transition.count !== 1) return NextResponse.json({ error: 'This report has already been reviewed', code: 'invalid_transition' }, { status: 409 });
    const reportUpdate = await prisma.weeklyReport.findUniqueOrThrow({ where: { id: report.id } });
    const locale = isLocale(report.relation.mentee.preferredLanguage) ? report.relation.mentee.preferredLanguage : defaultLocale;
    const copy = getDictionary(locale).weeklyReports;
    if (notificationCategoryAllowed(report.relation.mentee, 'weeklyReports')) {
      await notify(
        report.relation.menteeId,
        'weekly_report_review',
        parsed.data.status === 'APPROVED' ? copy.approvedNotification : copy.changesNotification,
        '/portal',
      );
    }
    return NextResponse.json({ report: reportUpdate });
  });
}
