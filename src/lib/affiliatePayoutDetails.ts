// The ONE writer and reader of a partner's payout details (docs/affiliate-module.md, #3115).
//
// The IBAN and holder are sealed with src/lib/secretBox.ts. A change is written
// with an AuditLog row in the same transaction and then announced to the partner
// through the one security-notice sender (src/lib/securityNotices.ts): whoever
// takes over a partner account and redirects the payouts is seen by the owner.
// Neither the audit row nor the notice ever carries the IBAN — the last four
// characters at most.

import type { HeaderSource } from '@/lib/clientIp';
import { prisma } from '@/lib/prisma';
import { open, seal } from '@/lib/secretBox';
import { sendSecurityNotice } from '@/lib/securityNotices';
import { maskIban, type PayoutDetails } from '@/lib/payoutDetailsRule';

const PURPOSE = 'affiliate-payout-details';

export type PayoutDetailsErrorCode = 'partner_not_found' | 'partner_suspended';

export class PayoutDetailsError extends Error {
  readonly code: PayoutDetailsErrorCode;
  constructor(code: PayoutDetailsErrorCode) {
    super(code);
    this.name = 'PayoutDetailsError';
    this.code = code;
  }
}

export interface PayoutDetailsActor {
  id: string;
  role: 'ADMIN' | 'AFFILIATE';
}

/**
 * Stores new payout details for a partner. A SUSPENDED partner's details are
 * frozen. `request` is passed only when the partner acts themself: an
 * admin-side notice must not quote the administrator's browser.
 */
export async function setPayoutDetails(input: {
  orgId: string;
  partnerId: string;
  details: PayoutDetails;
  actor: PayoutDetailsActor;
  request?: HeaderSource | null;
}): Promise<{ masked: string }> {
  const sealed = seal(JSON.stringify(input.details), PURPOSE);
  const masked = maskIban(input.details.iban);

  const partner = await prisma.$transaction(async (tx) => {
    const row = await tx.affiliatePartner.findFirst({
      where: { id: input.partnerId, orgId: input.orgId },
      select: { id: true, userId: true, status: true },
    });
    if (!row) throw new PayoutDetailsError('partner_not_found');
    if (row.status === 'SUSPENDED') throw new PayoutDetailsError('partner_suspended');
    await tx.affiliatePartner.updateMany({
      where: { id: row.id, orgId: input.orgId },
      data: { payoutDetailsCipher: sealed },
    });
    await tx.auditLog.create({
      data: {
        orgId: input.orgId,
        actorId: input.actor.id,
        action: 'affiliate.payout_details.update',
        targetId: row.userId ?? row.id,
        detail: JSON.stringify({ partnerId: row.id, by: input.actor.role, iban: masked }),
      },
    });
    return row;
  });

  if (partner.userId) {
    await sendSecurityNotice('payoutDetailsChanged', {
      userId: partner.userId,
      request: input.actor.role === 'AFFILIATE' ? input.request : null,
    });
  }
  return { masked };
}

/** The stored details, in full. ADMIN only (the manual transfer); a partner gets `maskedPayoutDetails`. */
export async function readPayoutDetails(orgId: string, partnerId: string): Promise<PayoutDetails | null> {
  const row = await prisma.affiliatePartner.findFirst({
    where: { id: partnerId, orgId },
    select: { payoutDetailsCipher: true },
  });
  if (!row?.payoutDetailsCipher) return null;
  const plain = open(row.payoutDetailsCipher, PURPOSE);
  if (!plain) return null;
  try {
    const parsed = JSON.parse(plain) as PayoutDetails;
    return typeof parsed.iban === 'string' && typeof parsed.holder === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export async function maskedPayoutDetails(orgId: string, partnerId: string): Promise<{ iban: string; holder: string } | null> {
  const full = await readPayoutDetails(orgId, partnerId);
  return full ? { iban: maskIban(full.iban), holder: full.holder } : null;
}
