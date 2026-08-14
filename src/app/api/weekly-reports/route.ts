import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { utcWeekStart } from '@/lib/week';
import { canReadWeeklyReports, reportOrganizationId, weeklyReportRelation } from '@/lib/weeklyReports';

const createSchema = z.object({
  relationId: z.string().min(1),
  summary: z.string().max(TEXT_LIMITS.weeklyReportSummary).default(''),
  hoursSpent: z.number().int().min(0).max(168).nullable().optional(),
  blockers: z.string().max(TEXT_LIMITS.weeklyReportBlockers).nullable().optional(),
  status: z.enum(['DRAFT', 'SUBMITTED']).default('DRAFT'),
}).strict();

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return withTenantScope(session, async () => {
    const query = new URL(request.url).searchParams;
    const relationId = query.get('relationId') || '';
    const relation = await weeklyReportRelation(relationId);
    if (!relation) return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
    if (!canReadWeeklyReports(session.user, relation)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const page = Math.max(1, Number(query.get('page')) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(query.get('pageSize')) || 20));
    const [reports, total] = await Promise.all([
      prisma.weeklyReport.findMany({ where: { relationId }, orderBy: { weekStart: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.weeklyReport.count({ where: { relationId } }),
    ]);
    return NextResponse.json({
      reports,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total,
      currentWeekStart: utcWeekStart(new Date()),
    });
  });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Only mentees can create weekly reports' }, { status: 403 });
  return withTenantScope(session, async () => {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    const relation = await weeklyReportRelation(parsed.data.relationId);
    if (!relation) return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
    if (relation.menteeId !== session.user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (relation.status !== 'ACTIVE') return NextResponse.json({ error: 'The mentorship is not active', code: 'inactive_relation' }, { status: 409 });
    const orgId = reportOrganizationId(relation);
    if (!orgId) return NextResponse.json({ error: 'The mentorship has no organization configured', code: 'missing_organization' }, { status: 409 });
    const summary = parsed.data.summary.trim();
    if (parsed.data.status === 'SUBMITTED' && !summary) return NextResponse.json({ error: 'Summary is required before submission', code: 'summary_required' }, { status: 400 });
    try {
      const report = await prisma.weeklyReport.create({
        data: {
          orgId,
          relationId: relation.id,
          weekStart: utcWeekStart(new Date()),
          summary,
          hoursSpent: parsed.data.hoursSpent ?? null,
          blockers: parsed.data.blockers?.trim() || null,
          status: parsed.data.status,
        },
      });
      return NextResponse.json({ report }, { status: 201 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return NextResponse.json({ error: 'A report already exists for this week', code: 'weekly_report_exists' }, { status: 409 });
      }
      throw error;
    }
  });
}
