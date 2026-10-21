import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';
import { notifyIfAllowed } from '@/lib/notify';
import { APPLICATION_SELECT, visibleApplicationsWhere } from '@/lib/applicationStage';
import { visibleJobsWhere } from '@/lib/portalJobs';
import { SCREENING_LIMITS, parseScreeningQuestions, validateAnswers } from '@/lib/screeningQuestions';

const LIST_MAX = 200;

// GET — applications, role-branched in the handler through the ONE visibility
// filter (visibleApplicationsWhere): a MENTEE their own, a COMPANY its own
// requisitions', a MENTOR their active mentees', an ADMIN the org's. Never a
// client-side filter. A mentee never reads a disposition reason back (#1801).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return capGate;
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ applications: [] });
  const scope = visibleApplicationsWhere({ id: session.user.id, role: session.user.role, orgId, companyId: session.user.companyId ?? null });
  if (!scope) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return withTenantScope(session, async () => {
    const rows = await prisma.application.findMany({
      where: scope,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: LIST_MAX,
      select: { ...APPLICATION_SELECT, requisition: { select: { id: true, title: true, company: { select: { id: true, name: true } } } } },
    });
    const applications = session.user.role === 'MENTEE' ? rows.map((a) => ({ ...a, dispositionCode: null })) : rows;
    return NextResponse.json({ applications });
  });
}

const applySchema = z.object({
  requisitionId: z.string().trim().min(1).max(64),
  coverNote: z.string().trim().max(SCREENING_LIMITS.coverNote).optional(),
  screeningAnswers: z.record(z.union([z.string().max(SCREENING_LIMITS.textAnswer), z.boolean()])).optional(),
}).strict();

// POST — a mentee applies to an open role (#1832). Free core: no plan or
// entitlement anywhere on this path. The role must be visible on the job board
// (OPEN, a seat free, the mentee's org — the same rule as GET
// /api/portal/requisitions; anything else is a 404). Screening answers are
// checked against that role's questions here, not only in the form. A second
// application is refused by @@unique([requisitionId, menteeId]) → 409
// already_applied, never by a read-then-write check. The row is created at
// APPLIED with its first ApplicationEvent; later moves go through
// moveApplicationStage(). The requisition's owner, the company's users and the
// mentee's active mentor are told — the mentor gate is the point.
export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const limited = enforceRateLimit(request, 'application-create', { limit: 20, windowMs: 60 * 60 * 1000, subject: session.user.id });
    if (limited) return limited;
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const parsed = applySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });
    const { requisitionId, coverNote, screeningAnswers } = parsed.data;

    return withTenantScope(session, async () => {
      const requisition = await prisma.requisition.findFirst({
        where: { AND: [{ id: requisitionId }, visibleJobsWhere(orgId)] },
        select: { id: true, title: true, companyId: true, ownerId: true, screeningQuestions: true },
      });
      if (!requisition) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const checked = validateAnswers(parseScreeningQuestions(requisition.screeningQuestions), screeningAnswers);
      if (!checked.ok) return NextResponse.json({ error: 'Screening answers are not valid', code: checked.code, questionId: checked.questionId }, { status: 400 });

      let application;
      try {
        application = await prisma.application.create({
          data: {
            orgId,
            requisitionId: requisition.id,
            menteeId: session.user.id,
            companyId: requisition.companyId,
            source: 'SELF',
            stage: 'APPLIED',
            status: 'ACTIVE',
            coverNote: coverNote || null,
            screeningAnswers: checked.answers,
            events: { create: { fromStage: null, toStage: 'APPLIED', actorId: session.user.id, note: 'applied' } },
          },
          select: APPLICATION_SELECT,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return NextResponse.json({ error: 'You have already applied to this role', code: 'already_applied' }, { status: 409 });
        }
        throw error;
      }

      await logActivity({ action: 'application.create', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'application', targetId: application.id, detail: requisition.id, request, orgId });
      const [companyUsers, mentorships] = await Promise.all([
        prisma.user.findMany({ where: { orgId, role: 'COMPANY', isActive: true, companyId: requisition.companyId }, select: { id: true } }),
        prisma.mentorshipRelation.findMany({ where: { menteeId: session.user.id, status: 'ACTIVE' }, select: { mentorId: true, id: true } }),
      ]);
      const params = { candidate: session.user.name ?? '', role: requisition.title };
      const companyRecipients = new Set([...companyUsers.map((u) => u.id), ...(requisition.ownerId ? [requisition.ownerId] : [])]);
      for (const userId of companyRecipients) await notifyIfAllowed(userId, 'stageUpdates', 'job_application.received', params, `/company/requisitions/${requisition.id}`);
      for (const m of mentorships) await notifyIfAllowed(m.mentorId, 'stageUpdates', 'job_application.mentee_applied', params, `/mentor/mentees/${session.user.id}`);
      return NextResponse.json({ application }, { status: 201 });
    });
  });
}
