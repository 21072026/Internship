// Partners of the affiliate programme, as the admin manages them
// (docs/affiliate-module.md, #3116). Creating a partner and listing the programme
// live here; a partner's status and termination date move through
// changePartnerState() in src/lib/affiliatePaymentWriter.ts (they decide what
// accrues, so they take the partner lock), and payout details through
// src/lib/affiliatePayoutDetails.ts.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { maskedPayoutDetails } from '@/lib/affiliatePayoutDetails';

/** A referral code: what follows `?ref=`. Numbers and slugs both (a migrated code is kept verbatim). */
export const PARTNER_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export type PartnerInputIssue = 'code' | 'displayName' | 'contactEmail';

export interface PartnerInput {
  code: string;
  displayName: string;
  contactEmail: string | null;
}

/** Pure shape check of an admin's "new partner" form. */
export function parsePartnerInput(input: unknown): { ok: true; value: PartnerInput } | { ok: false; issues: PartnerInputIssue[] } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const issues: PartnerInputIssue[] = [];
  const code = typeof o.code === 'string' ? o.code.trim() : '';
  if (!PARTNER_CODE_RE.test(code)) issues.push('code');
  const displayName = typeof o.displayName === 'string' ? o.displayName.trim().replace(/\s+/g, ' ') : '';
  if (displayName.length === 0 || displayName.length > 160) issues.push('displayName');
  const rawEmail = typeof o.contactEmail === 'string' ? o.contactEmail.trim().toLowerCase() : '';
  const contactEmail = rawEmail === '' ? null : rawEmail;
  if (contactEmail !== null && (contactEmail.length > 191 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))) issues.push('contactEmail');
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { code, displayName, contactEmail } };
}

export class PartnerCodeTakenError extends Error {
  constructor() {
    super('code_taken');
    this.name = 'PartnerCodeTakenError';
  }
}

export async function createPartner(orgId: string, input: PartnerInput, actorId: string): Promise<{ id: string }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const partner = await tx.affiliatePartner.create({
        data: { orgId, code: input.code, displayName: input.displayName, contactEmail: input.contactEmail },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: { orgId, actorId, action: 'affiliate.partner.create', targetId: partner.id, detail: JSON.stringify({ code: input.code }) },
      });
      return partner;
    });
  } catch (e) {
    // The code is unique per organisation; case-insensitively, like every reference (collation).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new PartnerCodeTakenError();
    throw e;
  }
}

export interface PartnerRow {
  id: string;
  code: string;
  displayName: string;
  contactEmail: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  noticeEffectiveAt: string | null;
  hasAccount: boolean;
  customers: number;
  /** Minor units per commission status, in the plan currency. */
  totals: { PENDING: number; APPROVED: number; PAID: number };
  payoutIban: string | null; // masked
  createdAt: string;
}

/** The programme's partners with their counts and totals, summed in SQL (never from a page of rows). */
export async function listPartners(orgId: string): Promise<PartnerRow[]> {
  const [partners, customers, sums] = await Promise.all([
    prisma.affiliatePartner.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, code: true, displayName: true, contactEmail: true, status: true, noticeEffectiveAt: true, userId: true, payoutDetailsCipher: true, createdAt: true },
    }),
    prisma.affiliateCustomer.groupBy({ by: ['partnerId'], where: { orgId }, _count: { _all: true } }),
    prisma.affiliateCommission.groupBy({ by: ['partnerId', 'status'], where: { orgId }, _sum: { amountMinor: true } }),
  ]);
  const customerCount = new Map(customers.map((c) => [c.partnerId, c._count._all]));
  const rows: PartnerRow[] = [];
  for (const p of partners) {
    const total = (status: 'PENDING' | 'APPROVED' | 'PAID') =>
      sums.find((s) => s.partnerId === p.id && s.status === status)?._sum.amountMinor ?? 0;
    rows.push({
      id: p.id,
      code: p.code,
      displayName: p.displayName,
      contactEmail: p.contactEmail,
      status: p.status,
      noticeEffectiveAt: p.noticeEffectiveAt?.toISOString() ?? null,
      hasAccount: p.userId !== null,
      customers: customerCount.get(p.id) ?? 0,
      totals: { PENDING: total('PENDING'), APPROVED: total('APPROVED'), PAID: total('PAID') },
      payoutIban: p.payoutDetailsCipher ? (await maskedPayoutDetails(orgId, p.id))?.iban ?? null : null,
      createdAt: p.createdAt.toISOString(),
    });
  }
  return rows;
}
