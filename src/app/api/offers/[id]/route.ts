import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { requireCapability } from '@/lib/capabilityGate';
import type { Session } from 'next-auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { resolveOrgId } from '@/lib/orgScope';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import {
  canPerformAction,
  canSeeCompensation,
  compensationSelect,
  isDeclineReasonCode,
  letterSelect,
  isOfferAction,
  transitionForAction,
} from '@/lib/offers';
import { validateCompensation, type CompensationFields } from '@/lib/compensation';
import { compensationInputShape, mergeCompensation, pickCompensationInput } from '@/lib/compensationInput';
import { notifyOfferSent, notifyOfferDecided } from '@/lib/offerNotify';
import { validateOfferRequisition } from '@/lib/requisitions';
import { applyAcceptedOffer, requisitionCountDetail, type RequisitionCount } from '@/lib/hiringOutcome';
import { advanceOnAcceptedOffer } from '@/lib/offerAutoAdvance';
import { advanceApplicationOnAcceptedOffer } from '@/lib/applicationStage';
import { stageTransaction } from '@/lib/applicationStageEvents';
import { raiseOfferEvent } from '@/lib/offerEvents';
import { emit } from '@/lib/events/emit';
import { logger } from '@/lib/logger';
import { renderLetterForOffer } from '@/lib/offerLetterServer';
import { clientIp } from '@/lib/clientIp';
import { withRequestScope } from '@/lib/requestContext';

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

async function handleGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

    let result: typeof offer & Partial<CompensationFields> & { compensationNote?: string | null; history?: unknown[]; requisitionTitle?: string | null } = offer;
    if (canSeeCompensation({ role, isOwnMenteeOffer })) {
      // The note AND the structured figures (#1851), from one list — a column
      // the list does not name is never read for anyone.
      // The frozen letter states the pay, so it rides the same rule (#1857).
      const withComp = await prisma.offer.findUnique({ where: { id }, select: { ...compensationSelect(), ...letterSelect() } });
      result = { ...offer, ...withComp };
    }
    if (role === 'ADMIN') {
      // The click-to-accept record (#1857): ADMIN-only.
      const record = await prisma.offer.findUnique({ where: { id }, select: { acceptedIp: true, acceptedUserAgent: true } });
      result = { ...result, ...record };
    }

    if (offer.requisitionId) {
      const requisition = await prisma.requisition.findFirst({
        where: { id: offer.requisitionId, ...(offer.orgId ? { orgId: offer.orgId } : {}) },
        select: { title: true },
      });
      result = { ...result, requisitionTitle: requisition?.title ?? null };
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
  ...compensationInputShape,
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
async function handlePATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Placement write (#2364): every offer transition — edit, send, accept,
  // decline, withdraw — is refused for a vertical without 'placements'.
  const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return capGate;
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
      if (actionStr === 'send') {
        data.sentAt = now;
        // Freeze the letter as the candidate will read it (#1857): from here
        // on the snapshot, not the template, is what was offered. Rendered
        // from the DRAFT the checks above saw; the guarded flip below means a
        // send that loses the race writes nothing.
        const letter = await renderLetterForOffer(id);
        data.letterSnapshot = letter.markdown;
        data.letterLocale = letter.locale;
      }
      if (actionStr === 'accept' || actionStr === 'decline') {
        data.decidedAt = now;
        data.decidedById = session.user.id;
      }
      if (actionStr === 'accept') {
        // A click-to-accept record (#1857) — when (decidedAt), from where and
        // with what. NOT a qualified electronic signature.
        data.acceptedIp = clientIp(request).slice(0, 64);
        data.acceptedUserAgent = (request.headers.get('user-agent') ?? '').slice(0, 512) || null;
      }
      if (actionStr === 'decline') {
        data.declineReasonCode = declineReasonCode;
        data.declineNote = declineNote?.trim() || null;
      }
      if (actionStr === 'withdraw') data.decidedAt = now;

      // One transaction: the guarded status flip, and — for an acceptance — the
      // seat it takes in the requisition (#1411/#1854) and the candidate's
      // application for that requisition reaching HIRED (#1854). The flip is
      // conditional on the status the checks above saw, so two concurrent
      // requests cannot both move the same offer; the loser gets a 409, not a
      // second write.
      const outcome = await stageTransaction(async (tx) => {
        const flip = await tx.offer.updateMany({ where: { id, status: offer.status }, data });
        if (flip.count === 0) return null;
        const count: RequisitionCount =
          actionStr === 'accept' ? await applyAcceptedOffer(tx, offer, now) : { outcome: 'none' };
        const hired =
          actionStr === 'accept' && offer.requisitionId
            ? await advanceApplicationOnAcceptedOffer(tx, { requisitionId: offer.requisitionId, menteeId: offer.relation.menteeId, now })
            : null;
        return { count, hired };
      });
      if (!outcome) {
        return NextResponse.json({ error: 'Offer changed meanwhile', code: 'offer_changed' }, { status: 409 });
      }
      const updated = await prisma.offer.findUniqueOrThrow({ where: { id }, select: baseSelect });

      await prisma.auditLog.create({
        data: {
          actorId: session.user.id,
          action: `offer.${actionStr}`,
          targetId: id,
          orgId: resolveOrgId(session),
          detail:
            actionStr === 'decline'
              ? `reason ${declineReasonCode}`
              : [requisitionCountDetail(outcome.count), outcome.hired && `application ${outcome.hired.applicationId} ${outcome.hired.fromStage} → HIRED`]
                  .filter(Boolean)
                  .join('; ') || undefined,
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
      // Opt-in (#2658): move the relation to the hired stage through the shared
      // stage write path. After the commit and never able to fail the
      // acceptance; every skip is logged with its reason.
      if (actionStr === 'accept') {
        try {
          await advanceOnAcceptedOffer(offer);
        } catch (e) {
          logger.error('offer.auto_advance_failed', { offerId: id, error: e instanceof Error ? e.name : 'unknown' });
        }
      }
      if (actionStr === 'decline') await notifyOfferDecided(id, 'DECLINED');

      // On the bus (#1998), after the commit: one event per action, and the
      // acceptance that took the requisition's last seat fills it.
      const subject = { id, orgId: offer.orgId, requisitionId: offer.requisitionId, menteeId: offer.relation.menteeId };
      const actor = { id: session.user.id, type: 'user' as const };
      const eventName = ({ send: 'offer.sent', withdraw: 'offer.withdrawn', accept: 'offer.accepted', decline: 'offer.declined' } as const)[actionStr];
      await raiseOfferEvent(eventName, subject, actor);
      if (outcome.count.outcome === 'counted' && outcome.count.nowFilled) {
        await emit('requisition.filled', { requisitionId: outcome.count.requisitionId, offerId: id }, { orgId: offer.orgId, actor });
      }

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
    const normalizedRequisitionId = requisitionId || null;
    const effectiveCompanyId = companyId !== undefined ? companyId : offer.companyId;
    if (requisitionId !== undefined || companyId !== undefined) {
      const validation = await validateOfferRequisition(
        requisitionId !== undefined ? normalizedRequisitionId : offer.requisitionId,
        offer.orgId,
        effectiveCompanyId,
      );
      if (!validation.ok) {
        return NextResponse.json(
          { error: validation.code === 'requisition_not_found' ? 'Requisition not found' : 'Requisition belongs to another company', code: validation.code },
          { status: validation.status },
        );
      }
    }
    // The structured figures are validated as a SET against what is stored
    // (#1851): a PATCH that sends only `basePeriod: null` while an amount is
    // on the row would leave the amount meaningless, so the merge is checked,
    // not the patch.
    const compensationPatch = pickCompensationInput(parsed.data);
    const data: Prisma.OfferUncheckedUpdateInput = {};
    if (Object.keys(compensationPatch).length > 0) {
      const { compensationNote: _note, ...current } = await prisma.offer.findUniqueOrThrow({ where: { id }, select: compensationSelect() });
      void _note;
      const merged = mergeCompensation(current, compensationPatch);
      const compensationProblem = validateCompensation(merged);
      if (compensationProblem) {
        return NextResponse.json({ error: 'Invalid compensation', code: compensationProblem }, { status: 400 });
      }
      Object.assign(data, merged);
    }
    if (position !== undefined) data.position = position;
    if (requisitionId !== undefined) data.requisitionId = normalizedRequisitionId;
    if (companyId !== undefined) data.companyId = companyId;
    if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null;
    if (compensationNote !== undefined) data.compensationNote = compensationNote;
    if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;

    const updated = await prisma.offer.update({ where: { id }, data, select: { ...baseSelect, ...compensationSelect() } });
    return NextResponse.json({ offer: updated });
  });
}

// Every line this route logs carries its request id (#1601).
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, () => handleGET(request, ctx));
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, () => handlePATCH(request, ctx));
}
