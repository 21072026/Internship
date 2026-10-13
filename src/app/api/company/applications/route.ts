import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { isApplicationStage, isDispositionCode } from '@/lib/applications';

const PAGE_MAX = 200;

// GET — the applications to a company's requisitions, filterable by stage,
// dispositionCode, requisitionId and since (updatedAt ≥), so a past applicant
// rejected for one role can be rediscovered when the next one opens (#1836).
// A COMPANY session is scoped to its own company in the handler; an ADMIN sees
// the org and may narrow with ?companyId=. The disposition note is the
// company's own text and stays inside the company and the programme.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return capGate;
  const role = session.user.role;
  if (role !== 'COMPANY' && role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (role === 'COMPANY' && !session.user.companyId) {
    return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
  }
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });

  const q = new URL(request.url).searchParams;
  const stage = q.get('stage') || undefined;
  const dispositionCode = q.get('dispositionCode') || undefined;
  const requisitionId = q.get('requisitionId') || undefined;
  const sinceRaw = q.get('since') || undefined;
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  if (stage && !isApplicationStage(stage)) return NextResponse.json({ error: 'Unknown stage', code: 'unknown_stage' }, { status: 400 });
  if (dispositionCode && !isDispositionCode(dispositionCode)) {
    return NextResponse.json({ error: 'Unknown dispositionCode', code: 'unknown_disposition' }, { status: 400 });
  }
  if (since && Number.isNaN(since.getTime())) return NextResponse.json({ error: 'Invalid since', code: 'validation_failed' }, { status: 400 });
  const companyId = role === 'COMPANY' ? session.user.companyId! : q.get('companyId') || undefined;
  const take = Math.min(PAGE_MAX, Math.max(1, Number(q.get('pageSize')) || PAGE_MAX));

  return withTenantScope(session, async () => {
    const where: Prisma.ApplicationWhereInput = {
      orgId,
      ...(companyId ? { requisition: { companyId } } : {}),
      ...(stage ? { stage } : {}),
      ...(dispositionCode ? { dispositionCode } : {}),
      ...(requisitionId ? { requisitionId } : {}),
      ...(since ? { updatedAt: { gte: since } } : {}),
    };
    const applications = await prisma.application.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take,
      select: {
        id: true, stage: true, status: true, source: true, dispositionCode: true, dispositionNote: true,
        decidedAt: true, withdrawnAt: true, createdAt: true, updatedAt: true,
        requisition: { select: { id: true, title: true, status: true, companyId: true } },
        mentee: { select: { id: true, fullName: true } },
      },
    });
    return NextResponse.json({ applications });
  });
}
