import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { decideInterviewRequestSchema } from '@/lib/interviewRequests';
import { isInterviewDeclineReasonCode } from '@/lib/interviewDeclineReasons';
import { notify, notifyIfAllowed } from '@/lib/notify';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
  const parsed = decideInterviewRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });
  const { id } = await params;

  return withTenantScope(session, async () => {
    const current = await prisma.interviewRequest.findFirst({
      where: {
        id, orgId,
        ...(session.user.role === 'MENTOR' ? { mentee: { menteeRelations: { some: { mentorId: session.user.id, status: 'ACTIVE', orgId } } } } : {}),
      },
      select: { id: true, status: true, menteeId: true, requisitionId: true, companyId: true, mentee: { select: { preferredLanguage: true } } },
    });
    if (!current) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
    if (current.status !== 'PENDING') return NextResponse.json({ error: 'Request already decided', code: 'already_decided' }, { status: 409 });
    if (
      parsed.data.action === 'decline' &&
      (!parsed.data.declineReasonCode || !isInterviewDeclineReasonCode(parsed.data.declineReasonCode))
    ) {
      return NextResponse.json({ error: 'A valid declineReasonCode is required', code: 'decline_reason_required' }, { status: 400 });
    }
    const nextStatus = parsed.data.action === 'approve' ? 'APPROVED' : 'DECLINED';
    const decidedAt = new Date();
    const declineReasonCode = parsed.data.action === 'decline' ? parsed.data.declineReasonCode! : null;
    const declineNote = parsed.data.action === 'decline' ? parsed.data.declineNote?.trim() || null : null;
    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.interviewRequest.updateMany({
        where: { id: current.id, orgId, status: 'PENDING' },
        data: {
          status: nextStatus,
          decidedById: session.user.id,
          decidedAt,
          ...(nextStatus === 'DECLINED' ? { declineReasonCode, declineNote } : {}),
          activeKey: null,
        },
      });
      if (changed.count !== 1) return false;
      await tx.auditLog.create({
        data: {
          actorId: session.user.id,
          action: 'INTERVIEW_REQUEST_DECIDED',
          targetId: current.id,
          detail: `${nextStatus}; mentee=${current.menteeId}; requisition=${current.requisitionId}${declineReasonCode ? `; reason=${declineReasonCode}` : ''}`,
        },
      });
      return true;
    });
    if (!result) return NextResponse.json({ error: 'Request already decided', code: 'already_decided' }, { status: 409 });
    if (nextStatus === 'APPROVED') {
      await notify(current.menteeId, 'interview_request.approved', {}, '/portal');
    } else {
      // InterviewRequest does not record which company user created it, so the
      // decision belongs to the company account as a whole. Notify every active
      // company user in the same tenant; each person's mentorship preference is
      // still honoured by notifyIfAllowed.
      const companyUsers = await prisma.user.findMany({
        where: { orgId, companyId: current.companyId, role: 'COMPANY', isActive: true },
        select: { id: true },
      });
      await Promise.all(
        companyUsers.map((user) =>
          notifyIfAllowed(
            user.id,
            'mentorship',
            'interview_request.declined',
            { reasonCode: declineReasonCode! },
            `/company/requisitions/${current.requisitionId}`
          )
        )
      );
    }
    return NextResponse.json({ ok: true, status: nextStatus, pipelineRecommendation: nextStatus === 'APPROVED' ? 'INTERVIEW_PENDING_250' : null });
  });
}
