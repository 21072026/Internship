// A partner's account: the programme's own invitation and the link made when it
// is accepted (docs/affiliate-module.md, #3117).
//
// A partner exists before its account does (the admin creates it, or a
// migration does). The admin invites the partner's contact address; the invitee
// registers with a password of their own — no password or hash is ever taken
// from another system — and registration links the new account to the partner
// (`linkPartnerAccount`, called inside the registration's transaction).
//
// - Only an ACTIVE partner without an account can be invited, and only to its
//   own contact address: a named invitation is what proves the mailbox.
// - A new invitation withdraws the partner's open ones, so exactly one link is
//   live — the one in the newest mail.
// - The link is a guarded write (`userId: null`): two registrations racing on
//   one partner cannot both own it, and the loser's account is rolled back.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createInvitation } from '@/lib/inviteCreate';
import { emailTakenInOrgWorld } from '@/lib/userWorld';

export type PartnerInviteErrorCode =
  | 'partner_not_found'
  | 'already_linked' // the partner has an account already
  | 'partner_inactive' // suspended or terminated partners are not invited
  | 'no_contact_email'
  | 'email_taken'; // the address already has an account in this product

export class PartnerInviteError extends Error {
  readonly code: PartnerInviteErrorCode;
  constructor(code: PartnerInviteErrorCode) {
    super(code);
    this.name = 'PartnerInviteError';
    this.code = code;
  }
}

export async function invitePartner(input: {
  orgId: string;
  partnerId: string;
  actor: { id: string; email?: string | null };
  request?: Request;
}): Promise<{ invitationId: string; emailSent: boolean; registerUrl: string; withdrawn: number }> {
  const { orgId, partnerId } = input;
  const partner = await prisma.affiliatePartner.findFirst({
    where: { id: partnerId, orgId },
    select: { id: true, code: true, userId: true, status: true, contactEmail: true },
  });
  if (!partner) throw new PartnerInviteError('partner_not_found');
  if (partner.userId) throw new PartnerInviteError('already_linked');
  if (partner.status !== 'ACTIVE') throw new PartnerInviteError('partner_inactive');
  if (!partner.contactEmail) throw new PartnerInviteError('no_contact_email');
  if (await emailTakenInOrgWorld(partner.contactEmail, orgId)) throw new PartnerInviteError('email_taken');

  const { count: withdrawn } = await prisma.invitationToken.updateMany({
    where: { orgId, partnerId: partner.id, used: false, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // The mail's language is the inviter's (#1720), as on every other invitation.
  const inviter = await prisma.user.findUnique({ where: { id: input.actor.id }, select: { preferredLanguage: true } });
  const created = await createInvitation({
    actor: input.actor,
    orgId,
    email: partner.contactEmail,
    label: partner.code,
    role: 'AFFILIATE',
    locale: inviter?.preferredLanguage ?? null,
    partnerId: partner.id,
    request: input.request,
  });
  await prisma.auditLog.create({
    data: {
      orgId,
      actorId: input.actor.id,
      action: 'affiliate.partner.invite',
      targetId: partner.id,
      detail: JSON.stringify({ invitationId: created.invitationId, withdrawn, emailSent: created.emailSent }),
    },
  });
  return { invitationId: created.invitationId, emailSent: created.emailSent, registerUrl: created.registerUrl, withdrawn };
}

/**
 * Links a just-created account to its partner, inside the registration's
 * transaction. Throws when the partner is gone, has an account already, or is
 * no longer ACTIVE — the caller rolls the account back and refuses the token.
 */
export async function linkPartnerAccount(
  tx: Prisma.TransactionClient,
  link: { orgId: string; partnerId: string; userId: string },
): Promise<void> {
  const { count } = await tx.affiliatePartner.updateMany({
    where: { id: link.partnerId, orgId: link.orgId, userId: null, status: 'ACTIVE' },
    data: { userId: link.userId },
  });
  if (count !== 1) throw new PartnerInviteError('already_linked');
  await tx.auditLog.create({
    data: {
      orgId: link.orgId,
      actorId: link.userId,
      action: 'affiliate.partner.account_linked',
      targetId: link.partnerId,
      detail: JSON.stringify({ partnerId: link.partnerId }),
    },
  });
}
