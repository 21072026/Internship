import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { inCallerTenant } from '@/lib/tenantFilter';
import { canReadWeeklyReports } from '@/lib/weeklyReports';
import { complianceForRelation, expectedWeeks, internshipWindow, weekByWeek } from '@/lib/weeklyReportCompliance';
import { COMPLIANCE_RELATION_SELECT, INTERNED_WHERE } from '@/lib/weeklyReportComplianceQuery';

// GET — one intern's weekly reports, week by week (#1917): every week the
// compliance rule says is owed, with its state (missing / draft / submitted /
// approved / changes requested) and whether it was late — the drill-down
// behind a row of GET /api/admin/weekly-reports. Read-only.
//
// Authorization is the existing rule, not a second one: canReadWeeklyReports
// (lib/weeklyReports.ts) on top of the admin gate this path implies. Reports
// outside the owed weeks (the running week's draft, say) are listed apart, so
// nothing a mentee wrote is hidden from the reader.
export async function GET(_request: Request, { params }: { params: Promise<{ relationId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { relationId } = await params;

  return withTenantScope(session, async () => {
    const relation = await prisma.mentorshipRelation.findFirst({
      where: { AND: [{ id: relationId }, INTERNED_WHERE] },
      select: { ...COMPLIANCE_RELATION_SELECT, orgId: true, mentorId: true, menteeId: true },
    });
    // Another tenant's relation reads exactly like a missing one.
    if (!relation || !(await inCallerTenant(relation.orgId, session.user.orgId))) {
      return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
    }
    if (!canReadWeeklyReports(session.user, relation)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const [changes, reports] = await Promise.all([
      prisma.statusChange.findMany({ where: { relationId }, select: { fromStatus: true, toStatus: true, createdAt: true } }),
      prisma.weeklyReport.findMany({
        where: { relationId },
        orderBy: { weekStart: 'asc' },
        select: {
          id: true, weekStart: true, status: true, submittedAt: true, hoursSpent: true,
          reviewedAt: true, reviewedBy: { select: { id: true, fullName: true } }, createdAt: true,
        },
      }),
    ]);
    const window = internshipWindow({ ...relation, changes });
    const expected = expectedWeeks(window, new Date());
    const owed = new Set(expected.map((w) => w.getTime()));
    const { orgId: _orgId, mentorId: _mentorId, menteeId: _menteeId, ...shown } = relation;

    return NextResponse.json({
      relation: shown,
      internshipStart: window?.start ?? null,
      internshipEnd: window?.end ?? null,
      compliance: complianceForRelation({ expected, reports }),
      weeks: weekByWeek(expected, reports),
      otherReports: reports.filter((r) => !owed.has(r.weekStart.getTime())),
    });
  });
}
