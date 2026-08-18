import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { resolveOrgId } from '@/lib/orgScope';
import { companyInterestScopeKey } from '@/lib/companyInterests';
import { notify } from '@/lib/notify';

const bodySchema = z.object({
  menteeId: z.string().min(1),
  status: z.enum(['INTERESTED', 'SHORTLISTED', 'PASS']),
  note: z.string().max(1000).optional(),
  requisitionId: z.string().min(1).nullable().optional(),
}).strict();

// GET ?menteeId=... — the requester company's current interest on one candidate.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!session.user.companyId) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
  const companyId = session.user.companyId;
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });

  return await withTenantScope(session, async () => {
  const menteeId = new URL(request.url).searchParams.get('menteeId');
  const requisitionId = new URL(request.url).searchParams.get('requisitionId');
  if (requisitionId) {
    const requisition = await prisma.requisition.findFirst({ where: { id: requisitionId, orgId, companyId }, select: { id: true } });
    if (!requisition) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!menteeId) {
      const interests = await prisma.companyInterest.findMany({
        where: { companyId, requisitionId, status: 'SHORTLISTED' },
        select: { id: true, status: true, note: true, mentee: { select: { id: true, fullName: true } } },
        orderBy: { updatedAt: 'desc' },
      });
      return NextResponse.json({ interests });
    }
  }
  if (!menteeId) return NextResponse.json({ error: 'menteeId is required' }, { status: 400 });

  const interest = await prisma.companyInterest.findFirst({
    where: { companyId, menteeId, requisitionId: requisitionId ?? null },
  });
  return NextResponse.json({ interest });
  });
}

// POST — set (create or update) the requester company's interest on a
// candidate they have a mentorship relation with (EPIC: company shortlist).
// Notifies the mentor of that relation so the signal reaches the org.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!session.user.companyId) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
  const companyId = session.user.companyId;
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });

  return await withTenantScope(session, async () => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { menteeId, status, note, requisitionId } = parsed.data;

  if (requisitionId) {
    const requisition = await prisma.requisition.findFirst({ where: { id: requisitionId, orgId, companyId }, select: { id: true } });
    if (!requisition) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const relation = await prisma.mentorshipRelation.findFirst({
    where: { companyId, menteeId, orgId },
    select: { mentorId: true, mentee: { select: { fullName: true } } },
  });
  if (!relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });

  // Was there already an interest, and is this a genuine status change? Note-only
  // updates (e.g. the debounced note auto-save) must NOT re-notify the mentor.
  const scopeKey = companyInterestScopeKey(companyId, menteeId, requisitionId);
  // Existing rows predate scopeKey. Adopt the deterministic key in place on
  // their next write; never replace or rewrite the historical interest row.
  let existing = await prisma.companyInterest.findUnique({ where: { scopeKey }, select: { id: true, status: true, scopeKey: true } });
  if (!existing) {
    existing = await prisma.companyInterest.findFirst({
      where: { companyId, menteeId, requisitionId: requisitionId ?? null, scopeKey: null },
      select: { id: true, status: true, scopeKey: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      existing = await prisma.companyInterest.update({
        where: { id: existing.id },
        data: { scopeKey },
        select: { id: true, status: true, scopeKey: true },
      });
    }
  }
  const statusChanged = !existing || existing.status !== status;

  const interest = await prisma.companyInterest.upsert({
    where: { scopeKey },
    create: { companyId, menteeId, status, note, requisitionId: requisitionId ?? null, scopeKey },
    update: { status, note },
  });

  const STATUS_EVENT: Record<string, string> = {
    INTERESTED: 'company_interest.interested',
    SHORTLISTED: 'company_interest.shortlisted',
    PASS: 'company_interest.passed',
  };
  if (statusChanged) {
    const mentee = relation.mentee.fullName;
    await notify(
      relation.mentorId,
      company?.name ? STATUS_EVENT[status] : 'company_interest.generic',
      company?.name ? { company: company.name, mentee } : { mentee }
    );
  }

  await logActivity({
    action: 'company.interest.set',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: menteeId,
  });

  return NextResponse.json({ interest });
  });
}
