import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { createInterviewRequestSchema, interviewActiveKey } from '@/lib/interviewRequests';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['ADMIN', 'COMPANY', 'MENTOR'].includes(session.user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (session.user.role === 'COMPANY' && !session.user.companyId) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });

  return withTenantScope(session, async () => {
    const requisitionId = new URL(request.url).searchParams.get('requisitionId') || undefined;
    const where: Prisma.InterviewRequestWhereInput = {
      orgId,
      ...(requisitionId ? { requisitionId } : {}),
      ...(session.user.role === 'COMPANY' ? { companyId: session.user.companyId! } : {}),
      ...(session.user.role === 'MENTOR' ? { mentee: { menteeRelations: { some: { mentorId: session.user.id, status: 'ACTIVE', orgId } } } } : {}),
    };
    if (session.user.role === 'COMPANY' && requisitionId) {
      const own = await prisma.requisition.findFirst({ where: { id: requisitionId, orgId, companyId: session.user.companyId! }, select: { id: true } });
      if (!own) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const requests = await prisma.interviewRequest.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 100,
      include: {
        company: { select: { id: true, name: true } },
        requisition: { select: { id: true, title: true } },
        mentee: {
          select: {
            id: true,
            fullName: true,
            menteeRelations: {
              where: {
                orgId,
                status: 'ACTIVE',
                ...(session.user.role === 'MENTOR' ? { mentorId: session.user.id } : {}),
                ...(session.user.role === 'COMPANY' ? { companyId: session.user.companyId! } : {}),
              },
              select: { id: true },
              take: 1,
            },
          },
        },
        decidedBy: { select: { id: true, fullName: true } },
      },
    });
    return NextResponse.json({ requests });
  });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!session.user.companyId) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
  const parsed = createInterviewRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });

  return withTenantScope(session, async () => {
    const { requisitionId, menteeId, note, proposedSlots } = parsed.data;
    const [requisition, relation, shortlist] = await Promise.all([
      prisma.requisition.findFirst({ where: { id: requisitionId, orgId, companyId: session.user.companyId! }, select: { id: true } }),
      prisma.mentorshipRelation.findFirst({ where: { orgId, companyId: session.user.companyId!, menteeId, status: 'ACTIVE' }, select: { id: true } }),
      prisma.companyInterest.findFirst({ where: { companyId: session.user.companyId!, menteeId, requisitionId, status: 'SHORTLISTED' }, select: { id: true } }),
    ]);
    if (!requisition || !relation || !shortlist) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
    try {
      const created = await prisma.interviewRequest.create({
        data: { requisitionId, menteeId, companyId: session.user.companyId!, orgId, note: note || null, proposedSlots: proposedSlots ?? undefined, activeKey: interviewActiveKey(requisitionId, menteeId) },
      });
      return NextResponse.json({ request: created }, { status: 201 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return NextResponse.json({ error: 'A pending request already exists', code: 'already_pending' }, { status: 409 });
      throw error;
    }
  });
}
