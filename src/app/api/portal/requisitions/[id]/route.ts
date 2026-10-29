import { NextResponse } from 'next/server';
import { requireRoleOrPermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { PORTAL_JOB_SELECT, visibleJobsWhere } from '@/lib/portalJobs';
import { parseScreeningQuestions } from '@/lib/screeningQuestions';

// GET — one open role for the mentee's job board (#1830). The same visibility
// rule as the list; anything not visible — a draft, a full role, another org's
// — is a 404, never a 403 that would confirm it exists.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRoleOrPermission(['MENTEE'], 'company.read', { request: _request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return capGate;
  const orgId = resolveOrgId(session);
  const { id } = await params;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return withTenantScope(session, async () => {
    const job = await prisma.requisition.findFirst({ where: { AND: [{ id }, visibleJobsWhere(orgId)] }, select: { ...PORTAL_JOB_SELECT, company: { select: { id: true, name: true, logoUrl: true, description: true } } } });
    if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // The apply form (#1832): the role's screening questions, and whether this mentee already applied.
    const [extra, mine] = await Promise.all([
      prisma.requisition.findUnique({ where: { id: job.id }, select: { screeningQuestions: true } }),
      session.user.role === 'MENTEE'
        ? prisma.application.findUnique({ where: { requisitionId_menteeId: { requisitionId: job.id, menteeId: session.user.id } }, select: { id: true, stage: true } })
        : null,
    ]);
    return NextResponse.json({ job: { ...job, screeningQuestions: parseScreeningQuestions(extra?.screeningQuestions) }, myApplication: mine });
  });
}
