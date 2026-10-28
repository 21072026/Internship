import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { visibleApplicationsWhere } from '@/lib/applicationStage';
import { interviewRequestActorWhere } from '@/lib/interviewRequests';

// GET — the hiring side of one candidate (#1398): which company wants them for
// which role, where each application stands and every interview request, for
// the "Hiring" card on the candidate page.
//
// Scope is the server's, fail-closed, and comes from the rules every other
// reader uses — never a client-side filter:
//   applications       visibleApplicationsWhere()   (ADMIN the org, COMPANY its
//                                                    own requisitions', MENTOR its
//                                                    active mentees')
//   interview requests interviewRequestActorWhere() (the same three)
//   company interests  ADMIN the org's companies, COMPANY its own rows, MENTOR
//                      an active mentee's rows
// A MENTEE (or any other role) is refused outright: this view carries PASS
// flags and rejection codes, and a PASS is never relayed to the candidate
// (src/app/api/company/interests/route.ts). A candidate the caller may not see
// — another org, not the mentor's mentee, a company with no row on them — is a
// 404, never an empty 200 that confirms the id. The company's free-text notes
// go to ADMIN and to the company that wrote them, never to a mentor.
const ROLES = ['ADMIN', 'MENTOR', 'COMPANY'];

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const role = session.user.role;
    if (!ROLES.includes(role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    const companyId = session.user.companyId ?? null;
    const appScope = visibleApplicationsWhere({ id: session.user.id, role, orgId, companyId });
    const irScope = interviewRequestActorWhere({ role, userId: session.user.id, orgId, companyId });
    if (!appScope || !irScope) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
    const { id } = await params;

    return withTenantScope(session, async () => {
      const candidate = await prisma.user.findFirst({ where: { id, orgId, role: 'MENTEE' }, select: { id: true } });
      if (!candidate) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (role === 'MENTOR') {
        const mentors = await prisma.mentorshipRelation.count({ where: { orgId, menteeId: id, mentorId: session.user.id, status: 'ACTIVE' } });
        if (mentors === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }

      const interestScope: Prisma.CompanyInterestWhereInput =
        role === 'COMPANY' ? { companyId: companyId! } : { company: { orgId } };
      const withNotes = role === 'ADMIN' || role === 'COMPANY';

      const [applications, interests, interviewRequests] = await Promise.all([
        prisma.application.findMany({
          where: { AND: [appScope, { menteeId: id }] },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: 100,
          select: {
            id: true, stage: true, status: true, source: true, dispositionCode: true, createdAt: true, updatedAt: true,
            requisition: { select: { id: true, title: true, status: true } },
            company: { select: { id: true, name: true } },
          },
        }),
        prisma.companyInterest.findMany({
          where: { AND: [interestScope, { menteeId: id }] },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: 100,
          select: {
            id: true, status: true, note: withNotes, createdAt: true, updatedAt: true,
            company: { select: { id: true, name: true } },
            requisition: { select: { id: true, title: true } },
          },
        }),
        prisma.interviewRequest.findMany({
          where: { AND: [irScope, { menteeId: id }] },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 100,
          select: {
            id: true, status: true, proposedSlots: true, scheduledAt: true, decidedAt: true, createdAt: true,
            declineReasonCode: true, cancelReason: true,
            company: { select: { id: true, name: true } },
            requisition: { select: { id: true, title: true } },
            decidedBy: { select: { id: true, fullName: true } },
          },
        }),
      ]);

      if (role === 'COMPANY' && applications.length === 0 && interests.length === 0 && interviewRequests.length === 0) {
        const related = await prisma.mentorshipRelation.count({ where: { orgId, menteeId: id, companyId: companyId! } });
        if (related === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }

      return NextResponse.json({ applications, interests, interviewRequests });
    });
  });
}
