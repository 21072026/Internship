import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Session } from 'next-auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import {
  canPerformAction,
  canSeeCompensation,
  isDeclineReasonCode,
  isOfferAction,
  transitionForAction,
} from '@/lib/offers';
import { notifyOfferSent, notifyOfferDecided } from '@/lib/offerNotify';

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
  relation: { select: { id: true, menteeId: true, mentorId: true, orgId: true, pipelineStatus: true } },
  company: { select: { id: true, name: true } },
  createdBy: { select: { id: true, fullName: true } },
  decidedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.OfferSelect;

// Loads the offer and decides the caller's authorization in one place, so
// every handler below applies the exact same rule.
async function loadAuthorized(id: string, session: Session) {
  const role = session.user.role;
  const offer = await prisma.offer.findUnique({ where: { id }, select: baseSelect });
  if (!offer) return { offer: null, isOwnMenteeOffer: false, authorized: false };

  const isOwnMenteeOffer = role === 'MENTEE' && offer.relation.menteeId === session.user.id;
  const isOwnCompanyOffer = role === 'COMPANY' && !!session.user.companyId && offer.companyId === session.user.companyId;
  // A DRAFT is admin-internal staging — never visible outside ADMIN, even by
  // guessing its id, until it has actually been sent.
  const authorized =
    role === 'ADMIN' || ((isOwnMenteeOffer || isOwnCompanyOffer) && offer.status !== 'DRAFT');

  return { offer, isOwnMenteeOffer, authorized };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const role = session.user.role;
  if (role === 'COMPANY' && !session.user.companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
    const { offer, isOwnMenteeOffer, authorized } = await loadAuthorized(id, session);
    if (!offer) return NextResponse.json({ error: 'Offer not found' }, { status: 404 });
    if (!authorized) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    let result: typeof offer & { compensationNote?: string | null; history?: unknown[] } = offer;
    if (canSeeCompensation({ role, isOwnMenteeOffer })) {
      const withComp = await prisma.offer.findUnique({ where: { id }, select: { compensationNote: true } });
      result = { ...offer, compensationNote: withComp?.compensationNote ?? null };
    }

    // Timeline history — ADMIN only (it also reveals actor identities).
    if (role === 'ADMIN') {
      const history = await prisma.auditLog.findMany({
        where: { targetId: id, action: { startsWith: 'offer.' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, action: true, detail: true, actorId: true, createdAt: true },
      });
      result = { ...result, history };
    }

    return NextResponse.json({ offer: result });
  });
}

const editSchema = z.object({
  position: z.string().min(1).max(200).optional(),
  requisitionId: z.string().max(100).nullable().optional(),
  companyId: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  compensationNote: z.string().max(2000).nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});

const actionSchema = z.object({
  action: z.string().min(1),
  declineReasonCode: z.string().optional(),
  declineNote: z.string().max(1000).optional(),
});

// PATCH — either a field edit on a DRAFT offer (ADMIN only), or a state
// transition via { action }. Which one runs is decided by whether `action` is
// present in the body; both share the same load/authorize step above.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const role = session.user.role;
  // COMPANY never mutates an offer — read-only per #809.
  if (role !== 'ADMIN' && role !== 'MENTEE') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
    const raw = await request.json().catch(() => null);
    if (!raw || typeof raw !== 'object') {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { offer, isOwnMenteeOffer, authorized } = await loadAuthorized(id, session);
    if (!offer) return NextResponse.json({ error: 'Offer not found' }, { status: 404 });
    if (!authorized) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    if ('action' in raw) {
      const parsed = actionSchema.safeParse(raw);
      if (!parsed.success) {
        return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
      }
      const { action: actionStr, declineReasonCode, declineNote } = parsed.data;
      if (!isOfferAction(actionStr)) {
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
      }
      if (
        !canPerformAction({
          role,
          isOwnMenteeOffer,
          currentStatus: offer.status,
          action: actionStr,
        })
      ) {
        return NextResponse.json({ error: 'Invalid transition' }, { status: 400 });
      }

      if (actionStr === 'decline') {
        if (!declineReasonCode || !isDeclineReasonCode(declineReasonCode)) {
          return NextResponse.json({ error: 'A valid declineReasonCode is required' }, { status: 400 });
        }
      }

      const { to } = transitionForAction(actionStr);
      const now = new Date();
      const data: Prisma.OfferUncheckedUpdateInput = { status: to };
      if (actionStr === 'send') data.sentAt = now;
      if (actionStr === 'accept' || actionStr === 'decline') {
        data.decidedAt = now;
        data.decidedById = session.user.id;
      }
      if (actionStr === 'decline') {
        data.declineReasonCode = declineReasonCode;
        data.declineNote = declineNote?.trim() || null;
      }
      if (actionStr === 'withdraw') data.decidedAt = now;

      const updated = await prisma.offer.update({ where: { id }, data, select: baseSelect });

      await prisma.auditLog.create({
        data: {
          actorId: session.user.id,
          action: `offer.${actionStr}`,
          targetId: id,
          detail: actionStr === 'decline' ? `reason ${declineReasonCode}` : undefined,
        },
      });
      await logActivity({
        action: `offer.${actionStr}`,
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'offer',
        targetId: id,
      });

      if (actionStr === 'send') await notifyOfferSent(id);
      if (actionStr === 'accept') await notifyOfferDecided(id, 'ACCEPTED');
      if (actionStr === 'decline') await notifyOfferDecided(id, 'DECLINED');

      return NextResponse.json({ offer: updated });
    }

    // Field edit — ADMIN only, and only while still a DRAFT (once sent, the
    // offer the mentee saw must not silently change under them).
    if (role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (offer.status !== 'DRAFT') {
      return NextResponse.json({ error: 'Only a draft offer can be edited' }, { status: 400 });
    }
    const parsed = editSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { position, requisitionId, companyId, startDate, compensationNote, expiresAt } = parsed.data;
    const data: Prisma.OfferUncheckedUpdateInput = {};
    if (position !== undefined) data.position = position;
    if (requisitionId !== undefined) data.requisitionId = requisitionId;
    if (companyId !== undefined) data.companyId = companyId;
    if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null;
    if (compensationNote !== undefined) data.compensationNote = compensationNote;
    if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;

    const updated = await prisma.offer.update({ where: { id }, data, select: { ...baseSelect, compensationNote: true } });
    return NextResponse.json({ offer: updated });
  });
}
