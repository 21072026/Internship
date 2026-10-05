import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { rollUp } from '@/lib/weeklyReportCompliance';
import { COMPLIANCE_RELATION_SELECT, INTERNED_WHERE, complianceRows, type ComplianceRow } from '@/lib/weeklyReportComplianceQuery';

// GET — org-wide weekly-report compliance (#1917), one row per interning
// relation plus the org roll-up. READ-ONLY: admins never write a report
// (src/app/api/weekly-reports/[id] answers them 403), and this listing is how
// a programme coordinator sees who is behind without opening every intern.
//
// Every number comes from src/lib/weeklyReportCompliance.ts — the definitions
// of expected / missing / late / rate live there, not here.
//
// QUERIES PER REQUEST — bounded, independent of the page size:
//   1 count + 1 relation page (Prisma adds one select per joined name: mentee,
//   mentor, company, cohort) + 2 in complianceRows() (stage moves, reports).
// A result set of up to ROLLUP_LIMIT relations is read in ONE page-sized go
// and paginated in memory, which is what makes an exact org roll-up possible
// at the same query count; above it the roll-up is `null` (narrow the filter —
// a cohort is the unit a coordinator signs for) rather than an unbounded scan.

const MAX_PAGE_SIZE = 100;
const ROLLUP_LIMIT = 500;

function parseDate(value: string | null): Date | null | 'invalid' {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'invalid' : date;
}

function toRow({ relation, compliance, lastSubmittedAt, window }: ComplianceRow) {
  return {
    relationId: relation.id,
    status: relation.status,
    pipelineStatus: relation.pipelineStatus,
    mentee: relation.mentee,
    mentor: relation.mentor,
    company: relation.company,
    cohort: relation.cohort,
    internshipStart: window?.start ?? null,
    internshipEnd: window?.end ?? null,
    expected: compliance.expected,
    submitted: compliance.submitted,
    reviewed: compliance.reviewed,
    missing: compliance.missing.length,
    late: compliance.late.length,
    missingWeeks: compliance.missing,
    lateWeeks: compliance.late,
    rate: compliance.rate,
    lastSubmittedAt,
  };
}

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;

  const query = new URL(request.url).searchParams;
  const rawStatus = query.get('status');
  if (rawStatus && rawStatus !== 'ACTIVE' && rawStatus !== 'COMPLETED') {
    return NextResponse.json({ error: 'status must be ACTIVE or COMPLETED' }, { status: 400 });
  }
  const status = rawStatus as 'ACTIVE' | 'COMPLETED' | null;
  const from = parseDate(query.get('from'));
  const to = parseDate(query.get('to'));
  if (from === 'invalid' || to === 'invalid') return NextResponse.json({ error: 'from/to must be ISO dates' }, { status: 400 });
  const page = Math.max(1, Math.floor(Number(query.get('page'))) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(query.get('pageSize'))) || 25));

  const filters: Prisma.MentorshipRelationWhereInput = {
    ...(query.get('cohortId') ? { cohortId: query.get('cohortId')! } : {}),
    ...(query.get('mentorId') ? { mentorId: query.get('mentorId')! } : {}),
    ...(query.get('companyId') ? { companyId: query.get('companyId')! } : {}),
    ...(status ? { status } : {}),
  };

  return withTenantScope(session, async () => {
    // The tenant is passed by hand: the central middleware is dormant while
    // MT_ENFORCE_ISOLATION is off (docs/tenant-isolation.md, #2542).
    const where = withinTenant({ AND: [INTERNED_WHERE, filters] } as Prisma.MentorshipRelationWhereInput, await tenantWhere(session));
    const total = await prisma.mentorshipRelation.count({ where });
    const whole = total <= ROLLUP_LIMIT;
    const skip = (page - 1) * pageSize;
    const relations = await prisma.mentorshipRelation.findMany({
      where,
      select: COMPLIANCE_RELATION_SELECT,
      orderBy: [{ mentee: { fullName: 'asc' } }, { id: 'asc' }],
      skip: whole ? 0 : skip,
      take: whole ? ROLLUP_LIMIT : pageSize,
    });
    const rows = await complianceRows(relations, new Date(), { from, to });
    const pageRows = whole ? rows.slice(skip, skip + pageSize) : rows;

    return NextResponse.json({
      rows: pageRows.map(toRow),
      rollUp: whole ? rollUp(rows.map((r) => r.compliance)) : null,
      rollUpLimit: ROLLUP_LIMIT,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total,
    });
  });
}
