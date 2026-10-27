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

// Bound to the organisation AND the partner: a sealed value copied onto another
// partner's row (a database-level swap) does not open there.
const purposeFor = (orgId: string, partnerId: string) => `affiliate-payout-details:${orgId}:${partnerId}`;

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
  const sealed = seal(JSON.stringify(input.details), purposeFor(input.orgId, input.partnerId));
  const masked = maskIban(input.details.iban);

  const partner = await prisma.$transaction(async (tx) => {
    const row = await tx.affiliatePartner.findFirst({
      where: { id: input.partnerId, orgId: input.orgId },
      select: { id: true, userId: true, status: true },
    });
    if (!row) throw new PayoutDetailsError('partner_not_found');
    if (row.status === 'SUSPENDED') throw new PayoutDetailsError('partner_suspended');
    // Guarded: a suspension committed after the read above still wins.
    const { count } = await tx.affiliatePartner.updateMany({
      where: { id: row.id, orgId: input.orgId, status: { not: 'SUSPENDED' } },
      data: { payoutDetailsCipher: sealed },
    });
    if (count !== 1) throw new PayoutDetailsError('partner_suspended');
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

/** Opens a sealed value already read from the partner row (no query of its own). */
function openDetails(orgId: string, partnerId: string, cipher: string | null): PayoutDetails | null {
  if (!cipher) return null;
  const plain = open(cipher, purposeFor(orgId, partnerId));
  if (!plain) return null;
  try {
    const parsed = JSON.parse(plain) as PayoutDetails;
    return typeof parsed.iban === 'string' && typeof parsed.holder === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** The stored details, in full. ADMIN only (the manual transfer); a partner gets `maskedPayoutDetails`. */
export async function readPayoutDetails(orgId: string, partnerId: string): Promise<PayoutDetails | null> {
  const row = await prisma.affiliatePartner.findFirst({
    where: { id: partnerId, orgId },
    select: { payoutDetailsCipher: true },
  });
  return openDetails(orgId, partnerId, row?.payoutDetailsCipher ?? null);
}

/** The masked IBAN from a cipher the caller already read — the partner list reads them all in one query. */
export function maskedIbanFromCipher(orgId: string, partnerId: string, cipher: string | null): string | null {
  const details = openDetails(orgId, partnerId, cipher);
  return details ? maskIban(details.iban) : null;
}

export async function maskedPayoutDetails(orgId: string, partnerId: string): Promise<{ iban: string; holder: string } | null> {
  const full = await readPayoutDetails(orgId, partnerId);
  return full ? { iban: maskIban(full.iban), holder: full.holder } : null;
}

/**
 * The full details for the admin who makes the transfer by hand. Every reveal is
 * audited (`affiliate.payout_details.read`), so "who looked at this IBAN" has an
 * answer; the row carries the masked value only.
 */
export async function revealPayoutDetails(orgId: string, partnerId: string, actorId: string): Promise<PayoutDetails | null> {
  const details = await readPayoutDetails(orgId, partnerId);
  if (details) {
    await prisma.auditLog.create({
      data: {
        orgId,
        actorId,
        action: 'affiliate.payout_details.read',
        targetId: partnerId,
        detail: JSON.stringify({ partnerId, iban: maskIban(details.iban) }),
      },
    });
  }
  return details;
}
