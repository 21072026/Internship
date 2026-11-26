// Inviting a partner by e-mail alone (docs/affiliate-module.md § The partner's
// account, #3963). The admin types an address — and, if they like, a name — and
// the partner is created and invited in one step. The partner then chooses its
// own name and referral code on the registration form (#3961), so the code made
// here is only a placeholder nobody has seen yet: `randomPartnerCode()`.
//
// - Under lockOrganization(), like createPartner() and the approval of an
//   application: the free code found by the loop below cannot be taken between
//   the check and the write, because every partner create takes the same lock.
// - An address that is a partner's contact already is `email_is_partner` (the
//   existing partner is invited from its own row), and one that has an account
//   in this product is `email_taken` — both before anything is written.
// - The invitation is the ordinary one (invitePartner), sent after the commit.

import { prisma } from '@/lib/prisma';
import { createPartnerLocked, lockOrganization } from '@/lib/affiliatePartners';
import { PartnerInviteError, invitePartner } from '@/lib/affiliateInvite';
import { randomPartnerCode } from '@/lib/affiliateCodeRule';
import { emailTakenInOrgWorld } from '@/lib/userWorld';

export type EmailInviteIssue = 'email' | 'displayName';

export interface EmailInviteInput {
  email: string;
  /** Null: the local part of the address stands in until the partner names itself. */
  displayName: string | null;
}

/** Pure shape check of the "invite a partner" form. */
export function parseEmailInviteInput(input: unknown): { ok: true; value: EmailInviteInput } | { ok: false; issues: EmailInviteIssue[] } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const issues: EmailInviteIssue[] = [];
  const email = typeof o.email === 'string' ? o.email.trim().toLowerCase() : '';
  if (email.length === 0 || email.length > 191 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) issues.push('email');
  const rawName = typeof o.displayName === 'string' ? o.displayName.trim().replace(/\s+/g, ' ') : '';
  if (rawName.length > 160) issues.push('displayName');
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { email, displayName: rawName === '' ? null : rawName } };
}

/** The stand-in name: the address's local part, never empty. */
export function placeholderName(email: string): string {
  const local = email.split('@')[0]?.trim() ?? '';
  return (local || email).slice(0, 160);
}

export class EmailInviteError extends Error {
  readonly code: 'email_is_partner' | 'email_taken';
  constructor(code: 'email_is_partner' | 'email_taken') {
    super(code);
    this.name = 'EmailInviteError';
    this.code = code;
  }
}

/** Tries before giving up on a free random code; 31^8 codes make a second try already rare. */
const CODE_ATTEMPTS = 8;

export async function invitePartnerByEmail(input: {
  orgId: string;
  value: EmailInviteInput;
  actor: { id: string; email?: string | null };
  request?: Request;
}): Promise<{
  partnerId: string;
  code: string;
  invitation: { emailSent: boolean; registerUrl: string | null } | null;
  inviteError: PartnerInviteError['code'] | null;
}> {
  const { orgId, value, actor } = input;
  if (await emailTakenInOrgWorld(value.email, orgId)) throw new EmailInviteError('email_taken');

  const partner = await prisma.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const existing = await tx.affiliatePartner.findFirst({ where: { orgId, contactEmail: value.email }, select: { id: true } });
    if (existing) throw new EmailInviteError('email_is_partner');
    let code: string | null = null;
    for (let i = 0; i < CODE_ATTEMPTS && code === null; i++) {
      const candidate = randomPartnerCode();
      const clash = await tx.affiliatePartner.findFirst({ where: { orgId, code: candidate }, select: { id: true } });
      if (!clash) code = candidate;
    }
    if (code === null) throw new Error('no free partner code after several attempts');
    const created = await createPartnerLocked(
      tx,
      orgId,
      { code, displayName: value.displayName ?? placeholderName(value.email), contactEmail: value.email },
      actor.id,
    );
    return { id: created.id, code };
  });

  // The partner exists now; if the invitation cannot be sent the partner stays,
  // and its own row offers the invitation again (the same as an approval).
  try {
    const sent = await invitePartner({ orgId, partnerId: partner.id, actor, request: input.request });
    return { partnerId: partner.id, code: partner.code, invitation: { emailSent: sent.emailSent, registerUrl: sent.registerUrl }, inviteError: null };
  } catch (e) {
    if (e instanceof PartnerInviteError) return { partnerId: partner.id, code: partner.code, invitation: null, inviteError: e.code };
    throw e;
  }
}
