// The admin's side of partner applications (docs/affiliate-module.md, #3362):
// list, approve, reject. Server-only. The one writer of an application's
// decision; the applicant's own writer is src/lib/affiliateApplications.ts.
//
// A decision moves PENDING → APPROVED | REJECTED exactly once: a guarded
// updateMany on `status: 'PENDING'`, so two admins clicking at once decide it
// once and the loser gets 409. An approval creates the partner in the SAME
// transaction (under the organisation lock createPartner() and the migration
// share), then hands it to the ordinary partner invitation (#3117) — there is
// no second way to give a partner an account. Another org's id is 404.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { lockOrganization, PARTNER_CODE_RE } from '@/lib/affiliatePartners';
import { PartnerInviteError, invitePartner } from '@/lib/affiliateInvite';
import { sendAffiliateApplicationRejectedEmail } from '@/services/emailService';
import { suggestPartnerCode, type ApplicationRejectionCode } from '@/lib/affiliateApplicationRule';

export type ApplicationReviewErrorCode = 'not_found' | 'already_decided' | 'invalid_code' | 'code_taken';

export class ApplicationReviewError extends Error {
  readonly code: ApplicationReviewErrorCode;
  constructor(code: ApplicationReviewErrorCode) {
    super(code);
    this.name = 'ApplicationReviewError';
    this.code = code;
  }
}

export interface ApplicationRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  company: string | null;
  phone: string | null;
  heardFrom: string;
  heardFromOther: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  decisionCode: string | null;
  partnerId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  /** For a PENDING row: the code the approve form starts with. */
  suggestedCode: string | null;
}

export function countPendingApplications(orgId: string): Promise<number> {
  return prisma.affiliateApplication.count({ where: { orgId, status: 'PENDING' } });
}

export async function listApplications(orgId: string, status: 'PENDING' | 'APPROVED' | 'REJECTED' | null): Promise<{ rows: ApplicationRow[]; pending: number }> {
  const [rows, pending] = await Promise.all([
    prisma.affiliateApplication.findMany({
      where: { orgId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true, firstName: true, lastName: true, email: true, company: true, phone: true, heardFrom: true,
        heardFromOther: true, status: true, decisionCode: true, partnerId: true, createdAt: true, decidedAt: true,
      },
    }),
    countPendingApplications(orgId),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, suggestedCode: r.status === 'PENDING' ? suggestPartnerCode(r.firstName, r.lastName) : null })),
    pending,
  };
}

export interface ApproveResult {
  partnerId: string;
  /** The invitation outcome; `inviteError` when the partner exists but no invitation could be sent. */
  invitation: { emailSent: boolean; registerUrl: string | null } | null;
  inviteError: PartnerInviteError['code'] | null;
}

export async function approveApplication(input: {
  orgId: string;
  applicationId: string;
  code: string;
  actor: { id: string; email?: string | null };
  request?: Request;
}): Promise<ApproveResult> {
  const { orgId, applicationId, actor } = input;
  const code = input.code.trim();
  if (!PARTNER_CODE_RE.test(code)) throw new ApplicationReviewError('invalid_code');

  let partnerId: string;
  try {
    partnerId = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, orgId);
      const app = await tx.affiliateApplication.findFirst({
        where: { id: applicationId, orgId },
        select: { status: true, firstName: true, lastName: true, email: true, company: true },
      });
      if (!app) throw new ApplicationReviewError('not_found');
      if (app.status !== 'PENDING') throw new ApplicationReviewError('already_decided');
      const name = `${app.firstName} ${app.lastName}`;
      const partner = await tx.affiliatePartner.create({
        data: { orgId, code, displayName: (app.company ? `${name} (${app.company})` : name).slice(0, 160), contactEmail: app.email },
        select: { id: true },
      });
      const { count } = await tx.affiliateApplication.updateMany({
        where: { id: applicationId, orgId, status: 'PENDING' },
        data: { status: 'APPROVED', decidedAt: new Date(), decidedById: actor.id, partnerId: partner.id },
      });
      if (count !== 1) throw new ApplicationReviewError('already_decided');
      await tx.auditLog.create({
        data: { orgId, actorId: actor.id, action: 'affiliate.application.approve', targetId: applicationId, detail: JSON.stringify({ partnerId: partner.id, code }) },
      });
      return partner.id;
    });
  } catch (e) {
    // The partner code is unique per organisation (case-insensitively, by collation).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApplicationReviewError('code_taken');
    throw e;
  }

  // The partner exists now; the invitation is the ordinary one. If it cannot be
  // sent (the address already has an account in this world, …), the approval
  // stands and the admin sees why, with the partner's own invite button to retry.
  try {
    const sent = await invitePartner({ orgId, partnerId, actor, request: input.request });
    return { partnerId, invitation: { emailSent: sent.emailSent, registerUrl: sent.registerUrl }, inviteError: null };
  } catch (e) {
    if (e instanceof PartnerInviteError) return { partnerId, invitation: null, inviteError: e.code };
    throw e;
  }
}

export async function rejectApplication(input: {
  orgId: string;
  applicationId: string;
  reason: ApplicationRejectionCode;
  /** The admin's own words: audit only, never on the row and never in the mail. */
  note: string | null;
  actor: { id: string };
}): Promise<void> {
  const { orgId, applicationId, reason, actor } = input;
  const app = await prisma.$transaction(async (tx) => {
    const row = await tx.affiliateApplication.findFirst({
      where: { id: applicationId, orgId },
      select: { status: true, email: true, firstName: true, locale: true },
    });
    if (!row) throw new ApplicationReviewError('not_found');
    const { count } = await tx.affiliateApplication.updateMany({
      where: { id: applicationId, orgId, status: 'PENDING' },
      data: { status: 'REJECTED', decidedAt: new Date(), decidedById: actor.id, decisionCode: reason },
    });
    if (count !== 1) throw new ApplicationReviewError('already_decided');
    await tx.auditLog.create({
      data: {
        orgId,
        actorId: actor.id,
        action: 'affiliate.application.reject',
        targetId: applicationId,
        detail: JSON.stringify({ reason, ...(input.note ? { note: input.note.slice(0, 500) } : {}) }),
      },
    });
    return row;
  });
  // After the commit: a failed mail never undoes a decision.
  try {
    await sendAffiliateApplicationRejectedEmail({ to: app.email, firstName: app.firstName, reason, locale: app.locale, orgId });
  } catch (e) {
    console.error('Affiliate application rejection mail failed:', e);
  }
}
