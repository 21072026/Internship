// The document review chain (#1859) — the Prisma-aware half. The rules are
// pure in src/lib/documentReview.ts; this module is the ONE writer of
// DocumentReview decisions and of Document.reviewStatus after upload, shared by
// the signed-in route (POST /api/documents/[id]/review), the account-less
// token route (/api/document-review/[token]) and the nightly expiry sweep.
//
// Every transition is a guarded `updateMany` whose WHERE carries the state the
// caller saw — an undecided step, a PENDING or APPROVED document — so a double
// submit or a race loses with a 409 instead of writing twice.
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { logger } from '@/lib/logger';
import { requirementLabel } from '@/lib/documentRequirements';
import { canDecideStep, nextStep, validityWindow, type ReviewDecision } from '@/lib/documentReview';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';

export const reviewDocumentSelect = {
  id: true,
  ownerId: true,
  title: true,
  reviewStatus: true,
  owner: { select: { id: true, fullName: true, role: true, orgId: true, preferredLanguage: true } },
  requirement: { select: { id: true, orgId: true, key: true, labels: true, validityDays: true, approvalMode: true } },
  reviews: { orderBy: { step: 'asc' as const }, select: { id: true, step: true, reviewerRole: true, reviewerEmail: true, decision: true, note: true, decidedAt: true } },
} as const;

export async function loadReviewDocument(documentId: string) {
  return prisma.document.findUnique({ where: { id: documentId }, select: reviewDocumentSelect });
}
export type ReviewDocument = NonNullable<Awaited<ReturnType<typeof loadReviewDocument>>>;

/** The facts canDecideStep() takes, read from the database for this actor and this owner. */
export async function actorFacts(actor: { id: string; role: string; companyId?: string | null }, ownerId: string | null) {
  if (!ownerId) return { isOwner: false, isOwnersActiveMentor: false, isOwnersCompany: false };
  const [mentored, companyRelation] = await Promise.all([
    actor.role === 'MENTOR'
      ? prisma.mentorshipRelation.findFirst({ where: { mentorId: actor.id, menteeId: ownerId, status: 'ACTIVE' }, select: { id: true } })
      : null,
    actor.role === 'COMPANY' && actor.companyId
      ? prisma.mentorshipRelation.findFirst({ where: { companyId: actor.companyId, menteeId: ownerId, status: 'ACTIVE' }, select: { id: true } })
      : null,
  ]);
  return { isOwner: actor.id === ownerId, isOwnersActiveMentor: !!mentored, isOwnersCompany: !!companyRelation };
}

export type DecisionResult =
  | { ok: true; documentStatus: string; step: number }
  | { ok: false; status: 400 | 403 | 409; code: string };

function ownerLink(role: string | undefined): string | undefined {
  return role === 'MENTEE' ? '/portal/profile#documents' : undefined;
}

function labelFor(doc: ReviewDocument): string {
  const pref = doc.owner?.preferredLanguage ?? null;
  const locale: Locale = isLocale(pref) ? pref : defaultLocale;
  return doc.requirement ? requirementLabel(doc.requirement.labels, locale, doc.requirement.key) : doc.title;
}

/**
 * Decide the current step. `step` is the step the reviewer saw: anything but
 * the lowest undecided step is refused (`out_of_order`), so step 2 can never be
 * approved before step 1. `by` is either a signed-in reviewer (authorized here
 * through canDecideStep) or an already-verified token holder for that step.
 */
export async function decideStep(params: {
  doc: ReviewDocument;
  step: number;
  decision: ReviewDecision;
  note?: string | null;
  by: { kind: 'user'; id: string; role: string; companyId?: string | null } | { kind: 'token'; reviewId: string };
  now?: Date;
}): Promise<DecisionResult> {
  const { doc, decision } = params;
  const now = params.now ?? new Date();
  const note = params.note?.trim() || null;
  if (doc.reviewStatus !== 'PENDING') return { ok: false, status: 409, code: 'not_pending' };
  const current = nextStep(doc.reviews);
  if (!current) return { ok: false, status: 409, code: 'not_pending' };
  if (current.step !== params.step) return { ok: false, status: 409, code: 'out_of_order' };
  if (decision === 'REJECTED' && !note) return { ok: false, status: 400, code: 'reason_required' };

  if (params.by.kind === 'user') {
    const facts = await actorFacts(params.by, doc.ownerId);
    if (!canDecideStep({ stepRole: current.reviewerRole, actorRole: params.by.role, ...facts })) {
      return { ok: false, status: 403, code: 'not_your_step' };
    }
  } else if (params.by.reviewId !== current.id || current.reviewerRole !== 'EXTERNAL') {
    return { ok: false, status: 409, code: 'out_of_order' };
  }

  const isLast = current.step === Math.max(...doc.reviews.map((r) => r.step));
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.documentReview.updateMany({
      where: { id: current.id, decision: null },
      data: {
        decision,
        note,
        decidedAt: now,
        reviewToken: null,
        ...(params.by.kind === 'user' ? { reviewerId: params.by.id } : {}),
      },
    });
    if (claimed.count !== 1) return 'conflict' as const;
    if (decision === 'REJECTED') {
      const moved = await tx.document.updateMany({ where: { id: doc.id, reviewStatus: 'PENDING' }, data: { reviewStatus: 'REJECTED' } });
      if (moved.count !== 1) throw new Error('document left PENDING under a claimed step');
      return 'REJECTED' as const;
    }
    if (isLast) {
      const moved = await tx.document.updateMany({
        where: { id: doc.id, reviewStatus: 'PENDING' },
        data: { reviewStatus: 'APPROVED', ...validityWindow(doc.requirement?.validityDays, now) },
      });
      if (moved.count !== 1) throw new Error('document left PENDING under a claimed step');
      return 'APPROVED' as const;
    }
    return 'PENDING' as const;
  });
  if (result === 'conflict') return { ok: false, status: 409, code: 'already_decided' };

  if (doc.ownerId && result !== 'PENDING') {
    const type = result === 'APPROVED' ? 'document.approved' : 'document.rejected';
    await notify(doc.ownerId, type, { requirement: labelFor(doc), ...(result === 'REJECTED' ? { reason: note ?? '' } : {}) }, ownerLink(doc.owner?.role));
  }
  return { ok: true, documentStatus: result, step: current.step };
}

/** A fresh link secret for an EXTERNAL step — the token is the credential, like MeetingGuest.rsvpToken. */
export function newReviewToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * The nightly expiry (#1859), the shape of expireOffers(): every APPROVED
 * document past validUntil flips to EXPIRED exactly once (guarded updateMany),
 * and the owner and the org's admins are told. The missing-document reminder
 * then picks the requirement up again by itself — completion is derived.
 * Platform-wide on purpose: a cron has no tenant context, so each notice is
 * addressed through the document's own requirement org.
 */
export async function expireDocuments(now: Date = new Date()): Promise<{ checked: number; expired: number }> {
  const due = await prisma.document.findMany({
    where: { reviewStatus: 'APPROVED', validUntil: { lt: now }, isTemplate: false },
    select: reviewDocumentSelect,
    take: 500,
  });
  let expired = 0;
  for (const doc of due) {
    const claim = await prisma.document.updateMany({ where: { id: doc.id, reviewStatus: 'APPROVED' }, data: { reviewStatus: 'EXPIRED' } });
    if (claim.count === 0) continue;
    expired += 1;
    try {
      const requirement = labelFor(doc);
      if (doc.ownerId) await notify(doc.ownerId, 'document.expired', { requirement }, ownerLink(doc.owner?.role));
      const orgId = doc.requirement?.orgId ?? doc.owner?.orgId ?? null;
      if (orgId) {
        const admins = await prisma.user.findMany({ where: { orgId, role: 'ADMIN', isActive: true }, select: { id: true } });
        for (const admin of admins) {
          await notify(admin.id, 'document.expired.admin', { requirement, owner: doc.owner?.fullName ?? '' }, '/admin/documents');
        }
      }
    } catch (e) {
      logger.error('document_expiry.notify_failed', { documentId: doc.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { checked: due.length, expired };
}
