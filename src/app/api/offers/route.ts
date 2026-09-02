import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { canSeeCompensation, isDeclineReasonCode, isOfferStatus } from '@/lib/offers';
import { validateOfferRequisition } from '@/lib/requisitions';
import { resolveOrgId } from '@/lib/orgScope';

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

// The /admin/offers index (#1873) pages server-side and takes its total from a
// separate count() on the same where — never from offers.length (#1438).
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const SORTABLE = ['expiresAt', 'sentAt', 'decidedAt', 'createdAt'] as const;

// Filters for the admin index. ADMIN-only on purpose: MENTEE/COMPANY keep the
// narrow legacy contract, because their fixed scoping is what makes the DRAFT
// and compensationNote rules hold — nothing here may widen it for them.
function adminFilters(sp: URLSearchParams): Prisma.OfferWhereInput {
  const where: Prisma.OfferWhereInput = {};

  // ?status=SENT&status=DECLINED or ?status=SENT,DECLINED. A value that is
  // given but entirely unknown narrows to nothing rather than quietly
  // returning everything.
  const statuses = sp.getAll('status').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  if (statuses.length) where.status = { in: statuses.filter(isOfferStatus) };

  const companyId = sp.get('companyId');
  if (companyId) where.companyId = companyId;
  const requisitionId = sp.get('requisitionId');
  if (requisitionId) where.requisitionId = requisitionId;

  const declineReasonCode = sp.get('declineReasonCode');
  if (declineReasonCode && isDeclineReasonCode(declineReasonCode)) where.declineReasonCode = declineReasonCode;

  // "Expiring this week": a deadline still ahead of now and inside the window.
  // Offers without an expiresAt drop out, which is the intent — they cannot
  // expire, so they are never about to.
  const days = Math.trunc(Number(sp.get('expiringWithinDays')));
  if (Number.isFinite(days) && days >= 1) {
    const window = Math.min(days, 90);
    where.expiresAt = { gte: new Date(), lte: new Date(Date.now() + window * 86_400_000) };
  }

  const sentAt: Prisma.DateTimeNullableFilter = {};
  const from = sp.get('from');
  const to = sp.get('to');
  if (from && !Number.isNaN(Date.parse(from))) sentAt.gte = new Date(from);
  if (to && !Number.isNaN(Date.parse(to))) sentAt.lte = new Date(to);
  if (sentAt.gte || sentAt.lte) where.sentAt = sentAt;

  const q = sp.get('q')?.trim();
  if (q) {
    where.OR = [
      { position: { contains: q } },
      { relation: { mentee: { fullName: { contains: q } } } },
    ];
  }

  return where;
}

// Requisitions are linked by plain id (see prisma/schema.prisma), so their
// titles are resolved separately — tenant-scoped, and null when the row is gone.
async function withRequisitionTitles<T extends { requisitionId: string | null }>(offers: T[], orgId: string | null) {
  const requisitionIds = [...new Set(offers.flatMap((offer) => offer.requisitionId ? [offer.requisitionId] : []))];
  const requisitions = requisitionIds.length
    ? await prisma.requisition.findMany({
        where: { id: { in: requisitionIds }, ...(orgId ? { orgId } : {}) },
        select: { id: true, title: true },
      })
    : [];
  const titles = new Map(requisitions.map((requisition) => [requisition.id, requisition.title]));
  return offers.map((offer) => ({ ...offer, requisitionTitle: offer.requisitionId ? titles.get(offer.requisitionId) ?? null : null }));
}

// GET ?relationId=&status=&companyId= — role-scoped offer list.
//   ADMIN   — everything, plus the /admin/offers index filters and server-side
//             paging; the response carries total/page/pageSize (#1873).
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
    const sp = new URL(request.url).searchParams;
    const relationId = sp.get('relationId') || undefined;

    const where: Prisma.OfferWhereInput = role === 'ADMIN' ? adminFilters(sp) : {};
    if (relationId) where.relationId = relationId;

    if (role !== 'ADMIN') {
      const status = sp.get('status') || undefined;
      if (status) where.status = status;

      if (role === 'MENTEE') {
        where.relation = { menteeId: session.user.id };
      } else {
        where.companyId = session.user.companyId as string;
      }
      // A DRAFT hasn't been sent yet — it's an admin staging state, never
      // visible to MENTEE/COMPANY, even indirectly through a list. Kept as a
      // separate AND term so an explicit ?status=DRAFT cannot opt back into it.
      where.AND = [{ status: { not: 'DRAFT' } }];
    }

    const select = canSeeCompensation({ role, isOwnMenteeOffer: role === 'MENTEE' })
      ? { ...baseSelect, compensationNote: true }
      : baseSelect;
    // The index shows who each offer is for, so ADMIN alone gets the mentee's
    // name joined in. Deliberately not folded into baseSelect: POST reuses it,
    // and no other role may gain a field because the admin list needed one.
    const listSelect = role === 'ADMIN'
      ? { ...select, relation: { select: { ...baseSelect.relation.select, mentee: { select: { id: true, fullName: true } } } } }
      : select;

    const orgId = resolveOrgId(session);

    if (role !== 'ADMIN') {
      const offers = await prisma.offer.findMany({ where, select: listSelect, orderBy: { createdAt: 'desc' } });
      return NextResponse.json({ offers: await withRequisitionTitles(offers, orgId) });
    }

    const sortParam = sp.get('sort');
    const sort = SORTABLE.find((candidate) => candidate === sortParam) ?? 'createdAt';
    const orderBy = { [sort]: sp.get('dir') === 'asc' ? 'asc' : 'desc' } as Prisma.OfferOrderByWithRelationInput;

    // One relation's offer history is a short list the candidate panel renders
    // whole (src/components/OfferManagementPanel.tsx), so ?relationId= keeps a
    // full page instead of being cut at the index default.
    const page = Math.max(1, Math.trunc(Number(sp.get('page'))) || 1);
    const requested = Math.trunc(Number(sp.get('pageSize'))) || (relationId ? MAX_PAGE_SIZE : DEFAULT_PAGE_SIZE);
    const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);

    const [offers, total] = await Promise.all([
      prisma.offer.findMany({ where, select: listSelect, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.offer.count({ where }),
    ]);

    return NextResponse.json({ offers: await withRequisitionTitles(offers, orgId), total, page, pageSize });
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

    const effectiveCompanyId = companyId !== undefined ? companyId : relation.companyId;
    const validation = await validateOfferRequisition(requisitionId, relation.orgId, effectiveCompanyId);
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.code === 'requisition_not_found' ? 'Requisition not found' : 'Requisition belongs to another company', code: validation.code },
        { status: validation.status },
      );
    }

    const offer = await prisma.offer.create({
      data: {
        orgId: relation.orgId,
        relationId,
        requisitionId: requisitionId || null,
        companyId: effectiveCompanyId,
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
