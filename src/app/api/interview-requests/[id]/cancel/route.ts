import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { notify, notifyIfAllowed } from '@/lib/notify';
import { cancelMeetingRows } from '@/lib/meetingCancel';
import { CANCELLABLE_INTERVIEW_STATUSES, cancelInterviewRequestSchema, interviewRequestActorWhere } from '@/lib/interviewRequests';

// POST — call an approved or scheduled interview off (#1844): the request
// becomes CANCELLED with the reason, and the linked Meeting leaves both
// calendars through the shared cancel path (src/lib/meetingCancel.ts) — never
// by deleting the row. Actors: the programme (ADMIN, the mentee's active
// MENTOR) and the requesting COMPANY for its own request. Everyone else who was
// expecting the interview is told.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Placement write (#2364).
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const role = session.user.role;
    if (role !== 'ADMIN' && role !== 'MENTOR' && role !== 'COMPANY') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (role === 'COMPANY' && !session.user.companyId) {
      return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
    }
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    const parsed = cancelInterviewRequestSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });
    const reason = parsed.data.reason?.trim() || null;
    const { id } = await params;
    const scope = interviewRequestActorWhere({ role, userId: session.user.id, orgId, companyId: session.user.companyId ?? null });
    if (!scope) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    return withTenantScope(session, async () => {
      const current = await prisma.interviewRequest.findFirst({
        where: { id, ...scope },
        select: {
          id: true, status: true, menteeId: true, requisitionId: true, companyId: true, meetingId: true,
          requisition: { select: { title: true } },
          mentee: { select: { menteeRelations: { where: { status: 'ACTIVE' }, select: { mentorId: true }, take: 1 } } },
        },
      });
      if (!current) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
      if (!(CANCELLABLE_INTERVIEW_STATUSES as readonly string[]).includes(current.status)) {
        return NextResponse.json({ error: 'Only an approved or scheduled request can be cancelled', code: 'not_cancellable', status: current.status }, { status: 409 });
      }
      const now = new Date();
      const changed = await prisma.interviewRequest.updateMany({
        where: { id: current.id, orgId, status: { in: [...CANCELLABLE_INTERVIEW_STATUSES] } },
        data: { status: 'CANCELLED', cancelledAt: now, cancelledById: session.user.id, cancelReason: reason },
      });
      if (changed.count !== 1) {
        return NextResponse.json({ error: 'The request changed meanwhile', code: 'not_cancellable' }, { status: 409 });
      }
      // The meeting, if one was created: off both calendars through the one
      // cancel path, the row kept for its notes (#1980).
      if (current.meetingId) {
        await cancelMeetingRows({ ids: [current.meetingId], actorId: session.user.id, reason, now });
      }
      await prisma.auditLog.create({
        data: {
          actorId: session.user.id,
          action: 'INTERVIEW_REQUEST_CANCELLED',
          targetId: current.id,
          orgId,
          detail: `from=${current.status}; by=${role}; meeting=${current.meetingId ?? 'none'}${reason ? `; reason=${reason}` : ''}`,
        },
      });

      // Tell everyone who was expecting it — except the one who called it off.
      const title = current.requisition.title;
      const mentorId = current.mentee.menteeRelations[0]?.mentorId ?? null;
      if (current.menteeId !== session.user.id) await notify(current.menteeId, 'interview_request.cancelled', { title }, '/portal');
      if (mentorId && mentorId !== session.user.id) {
        await notifyIfAllowed(mentorId, 'meetingReminders', 'interview_request.cancelled', { title }, '/mentor/meetings');
      }
      if (role !== 'COMPANY') {
        const companyUsers = await prisma.user.findMany({
          where: { orgId, companyId: current.companyId, role: 'COMPANY', isActive: true },
          select: { id: true },
        });
        for (const user of companyUsers) {
          await notifyIfAllowed(user.id, 'mentorship', 'interview_request.cancelled', { title }, `/company/requisitions/${current.requisitionId}`);
        }
      }
      await logActivity({
        action: 'interview_request.cancelled',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'interview_request',
        targetId: current.id,
        detail: `from=${current.status}; meeting=${current.meetingId ?? 'none'}${reason ? `; reason=${reason}` : ''}`,
        request,
        orgId,
      });
      // `interview_request.cancelled` is REGISTERED in WEBHOOK_EVENTS, not
      // dispatched from here (scripts/check-events.mjs caps the direct callers).
      return NextResponse.json({ ok: true, status: 'CANCELLED', meetingId: current.meetingId });
    });
  });
}
