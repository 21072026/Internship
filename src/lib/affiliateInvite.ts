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
// - A new invitation withdraws the partner's open ones, under the partner's row
//   lock, so exactly one link is live — the one in the newest mail. A partner
//   leaving ACTIVE withdraws them too (changePartnerState).
// - The register link is handed back to the admin only when the mail could not
//   be sent; the generic invitation board never resends a partner's invitation.
// - The link is a guarded write (`userId: null`): two registrations racing on
//   one partner cannot both own it, and the loser's account is rolled back.
// - The partner may choose its own code on the registration form (#3961): read
//   through the live invitation only (`partnerOfInvitation`), written in the
//   same guarded update as the link, and only while `partnerCodeLock()` says
//   the code is not fixed yet. A clash is `code_taken` — never the other
//   partner's name.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { deliverInvitation, invitationRegisterUrl, logInvitationCreated, persistInvitation, type CreateInvitationInput } from '@/lib/inviteCreate';
import { emailTakenInOrgWorld, worldOfOrg } from '@/lib/userWorld';
import { hostVertical } from '@/lib/hostVertical';
import { isPartnerCode, partnerCodeLock, type CodeAvailability, type CodeLock } from '@/lib/affiliateCodeRule';

export type PartnerInviteErrorCode =
  | 'partner_not_found'
  | 'already_linked' // the partner has an account already
  | 'partner_inactive' // suspended or terminated partners are not invited
  | 'no_contact_email'
  | 'email_taken' // the address already has an account in this product
  | 'code_invalid' // the chosen code is not a code (affiliateCodeRule.ts)
  | 'code_taken' // another partner of the programme has it
  | 'code_locked'; // the code is fixed already (partnerCodeLock)

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
}): Promise<{ invitationId: string; emailSent: boolean; registerUrl: string | null; withdrawn: number }> {
  const { orgId, partnerId } = input;
  // The mail's language is the inviter's (#1720), as on every other invitation.
  const inviter = await prisma.user.findUnique({ where: { id: input.actor.id }, select: { preferredLanguage: true } });

  // Withdraw and mint under the partner's row lock, in one transaction: two
  // clicks at once leave exactly one live link, and a suspension committed
  // meanwhile wins. The mail goes out after the commit (no SMTP inside a lock).
  const { invitation, persisted, withdrawn } = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM \`AffiliatePartner\` WHERE id = ${partnerId} AND orgId = ${orgId} FOR UPDATE`;
    if (locked.length === 0) throw new PartnerInviteError('partner_not_found');
    const partner = await tx.affiliatePartner.findFirst({
      where: { id: partnerId, orgId },
      select: { id: true, code: true, userId: true, status: true, contactEmail: true },
    });
    if (!partner) throw new PartnerInviteError('partner_not_found');
    if (partner.userId) throw new PartnerInviteError('already_linked');
    if (partner.status !== 'ACTIVE') throw new PartnerInviteError('partner_inactive');
    if (!partner.contactEmail) throw new PartnerInviteError('no_contact_email');
    if (await emailTakenInOrgWorld(partner.contactEmail, orgId)) throw new PartnerInviteError('email_taken');

    const { count } = await tx.invitationToken.updateMany({
      where: { orgId, partnerId: partner.id, used: false, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const invitation: CreateInvitationInput = {
      actor: input.actor,
      orgId,
      email: partner.contactEmail,
      label: partner.code,
      role: 'AFFILIATE',
      locale: inviter?.preferredLanguage ?? null,
      partnerId: partner.id,
      request: input.request,
    };
    const minted = await persistInvitation(invitation, tx);
    await tx.auditLog.create({
      data: {
        orgId,
        actorId: input.actor.id,
        action: 'affiliate.partner.invite',
        targetId: partner.id,
        detail: JSON.stringify({ invitationId: minted.invitationId, withdrawn: count }),
      },
    });
    return { invitation, persisted: minted, withdrawn: count };
  });

  await logInvitationCreated(invitation, persisted.invitationId);
  const { emailSent } = await deliverInvitation(invitation, persisted);
  // The live link goes back only when the mail did not go out, for the admin to
  // pass on by hand; otherwise the partner's mailbox is the only place it lives.
  const registerUrl = emailSent ? null : await invitationRegisterUrl(persisted.token, orgId);
  return { invitationId: persisted.invitationId, emailSent, registerUrl, withdrawn };
}

/**
 * Links a just-created account to its partner, inside the registration's
 * transaction. Throws when the partner is gone, has an account already, or is
 * no longer ACTIVE — the caller rolls the account back and refuses the token.
 */
export async function linkPartnerAccount(
  tx: Prisma.TransactionClient,
  link: { orgId: string; partnerId: string; userId: string; code?: string | null },
): Promise<void> {
  // The chosen code (#3961), when it differs from the current one. Read under
  // the partner's row lock so the lock rule and the write see the same row.
  let codeChange: { from: string; to: string } | null = null;
  if (link.code != null) {
    if (!isPartnerCode(link.code)) throw new PartnerInviteError('code_invalid');
    await tx.$queryRaw`SELECT id FROM \`AffiliatePartner\` WHERE id = ${link.partnerId} AND orgId = ${link.orgId} FOR UPDATE`;
    const partner = await tx.affiliatePartner.findFirst({ where: { id: link.partnerId, orgId: link.orgId }, select: { code: true } });
    if (!partner) throw new PartnerInviteError('already_linked');
    if (partner.code !== link.code) {
      if ((await codeLockOf(tx, link.orgId, link.partnerId, false)) !== null) throw new PartnerInviteError('code_locked');
      codeChange = { from: partner.code, to: link.code };
    }
  }
  let count: number;
  try {
    ({ count } = await tx.affiliatePartner.updateMany({
      where: { id: link.partnerId, orgId: link.orgId, userId: null, status: 'ACTIVE' },
      data: { userId: link.userId, ...(codeChange ? { code: codeChange.to } : {}) },
    }));
  } catch (e) {
    // `@@unique([orgId, code])`: another partner holds it (case-insensitively).
    if (codeChange && (e as { code?: string })?.code === 'P2002') throw new PartnerInviteError('code_taken');
    throw e;
  }
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
  if (codeChange) {
    await tx.auditLog.create({
      data: {
        orgId: link.orgId,
        actorId: link.userId,
        action: 'affiliate.partner.code_chosen',
        targetId: link.partnerId,
        detail: JSON.stringify({ partnerId: link.partnerId, from: codeChange.from, to: codeChange.to }),
      },
    });
  }
}

async function codeLockOf(db: Prisma.TransactionClient | typeof prisma, orgId: string, partnerId: string, hasAccount: boolean): Promise<CodeLock> {
  const [customers, clicks, commissions] = await Promise.all([
    db.affiliateCustomer.count({ where: { orgId, partnerId } }),
    db.affiliateClickDaily.count({ where: { orgId, partnerId } }),
    db.affiliateCommission.count({ where: { orgId, partnerId } }),
  ]);
  return partnerCodeLock({ hasAccount, customers, clicks, commissions });
}

/**
 * The partner a live AFFILIATE invitation of this world names, for its holder
 * only (#3961): the registration form shows the current code and whether it may
 * still be changed. Null for anything else — unknown, used, withdrawn, expired,
 * another world, another role — so the answer reveals nothing about a token the
 * caller does not hold. Read by token with no tenant context, like the register
 * route: the token is the authorisation.
 */
export async function partnerOfInvitation(token: string): Promise<{ orgId: string; partnerId: string; code: string; lock: CodeLock } | null> {
  const invitation = await prisma.invitationToken.findUnique({
    where: { token },
    select: { orgId: true, role: true, partnerId: true, used: true, revokedAt: true, expiresAt: true },
  });
  if (!invitation || invitation.role !== 'AFFILIATE' || !invitation.partnerId || !invitation.orgId) return null;
  if (invitation.used || invitation.revokedAt || invitation.expiresAt <= new Date()) return null;
  if ((await worldOfOrg(invitation.orgId)) !== (await hostVertical())) return null;
  const partner = await prisma.affiliatePartner.findFirst({
    where: { id: invitation.partnerId, orgId: invitation.orgId, status: 'ACTIVE' },
    select: { code: true, userId: true },
  });
  if (!partner) return null;
  const lock = await codeLockOf(prisma, invitation.orgId, invitation.partnerId, partner.userId !== null);
  return { orgId: invitation.orgId, partnerId: invitation.partnerId, code: partner.code, lock };
}

/**
 * Whether `code` is free for this partner. MySQL's collation compares codes
 * case-insensitively, the same way the unique key does, so `Ada` is taken when
 * `ada` exists. Never says WHO holds it.
 */
export async function partnerCodeAvailability(p: { orgId: string; partnerId: string; code: string }, current: string): Promise<CodeAvailability> {
  if (!isPartnerCode(p.code)) return 'invalid';
  if (p.code === current) return 'current';
  const holder = await prisma.affiliatePartner.findFirst({
    where: { orgId: p.orgId, code: p.code, NOT: { id: p.partnerId } },
    select: { id: true },
  });
  return holder ? 'taken' : 'available';
}
