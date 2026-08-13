import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { canSeeCompensation } from '@/lib/offers';

// Fields every authorized caller may see. compensationNote is added on top of
// this only for ADMIN / the offer's own MENTEE — see canSeeCompensation().
const baseSelect = {
  id: true,
  orgId: true,
  relationId: true,
  requisitionId: true,
  companyId: true,
  status: true,
  position: true,
  startDate: true,
  expiresAt: true,
  sentAt: true,
  decidedAt: true,
  declineReasonCode: true,
  declineNote: true,
  createdById: true,
  decidedById: true,
  createdAt: true,
  updatedAt: true,
  relation: { select: { id: true, menteeId: true, mentorId: true, pipelineStatus: true } },
  company: { select: { id: true, name: true } },
  createdBy: { select: { id: true, fullName: true } },
  decidedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.OfferSelect;

// GET ?relationId=&status=&companyId= — role-scoped offer list.
//   ADMIN   — everything (optionally filtered).
//   MENTEE  — only offers on relations where they are the mentee.
//   COMPANY — only offers on their own companyId; no companyId => 403.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const role = session.user.role;
  if (role !== 'ADMIN' && role !== 'MENTEE' && role !== 'COMPANY') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (role === 'COMPANY' && !session.user.companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
    const url = new URL(request.url);
    const relationId = url.searchParams.get('relationId') || undefined;
    const status = url.searchParams.get('status') || undefined;

    const where: Prisma.OfferWhereInput = {};
    if (relationId) where.relationId = relationId;
    if (status) where.status = status;

    if (role === 'MENTEE') {
      where.relation = { menteeId: session.user.id };
    } else if (role === 'COMPANY') {
      where.companyId = session.user.companyId as string;
    }
    // A DRAFT hasn't been sent yet — it's an admin staging state, never
    // visible to MENTEE/COMPANY, even indirectly through a list. Kept as a
    // separate AND term so an explicit ?status=DRAFT cannot opt back into it.
    if (role !== 'ADMIN') where.AND = [{ status: { not: 'DRAFT' } }];

    const select = canSeeCompensation({ role, isOwnMenteeOffer: role === 'MENTEE' })
      ? { ...baseSelect, compensationNote: true }
      : baseSelect;

    const offers = await prisma.offer.findMany({
      where,
      select,
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ offers });
  });
}

const createSchema = z.object({
  relationId: z.string().min(1),
  requisitionId: z.string().max(100).nullable().optional(),
  companyId: z.string().nullable().optional(),
  position: z.string().min(1).max(200),
  startDate: z.string().nullable().optional(),
  compensationNote: z.string().max(2000).nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});

// POST — create a DRAFT offer (ADMIN only). The 3-step admin wizard collects
// fields client-side and only calls this once, on the final preview step; it
// then calls PATCH { action: 'send' } separately to actually send it.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { relationId, requisitionId, companyId, position, startDate, compensationNote, expiresAt } = parsed.data;

    const relation = await prisma.mentorshipRelation.findUnique({
      where: { id: relationId },
      select: { id: true, orgId: true, companyId: true },
    });
    if (!relation) return NextResponse.json({ error: 'Relation not found' }, { status: 404 });

    const offer = await prisma.offer.create({
      data: {
        orgId: relation.orgId,
        relationId,
        requisitionId: requisitionId || null,
        companyId: companyId !== undefined ? companyId : relation.companyId,
        status: 'DRAFT',
        position,
        startDate: startDate ? new Date(startDate) : null,
        compensationNote: compensationNote || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        createdById: session.user.id,
      },
      select: { ...baseSelect, compensationNote: true },
    });

    await prisma.auditLog.create({
      data: { actorId: session.user.id, action: 'offer.create', targetId: offer.id, detail: `relation ${relationId}` },
    });
    await logActivity({
      action: 'offer.create',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'offer',
      targetId: offer.id,
    });

    return NextResponse.json({ offer }, { status: 201 });
  });
}
