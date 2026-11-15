// The affiliate behind a lead (#3647): which partner brought it — for the
// "Affiliate: <partner>" badge on the lead page and the board card — and, for
// the partner's own portal, how many leads it brought and where they are.
//
// TENANT: a partner is found by (orgId, code) — the code alone is unique only
// inside one org (`@@unique([orgId, code])`), so every lookup carries the
// lead's own org. A lead of another org never names this org's partner.
//
// WHAT THE PARTNER SEES: counts per stage, nothing else — no lead name, no
// contact, no account. The same line `affiliateCustomerLabelRule` draws: a
// partner reads only what an admin chose to write for them, and nobody wrote a
// lead's name for the partner.

import { prisma } from '@/lib/prisma';
import { affiliateCodeOf, affiliateSourceName } from '@/lib/affiliateSourceRule';

const pairKey = (orgId: string, code: string) => `${orgId}\u0000${code}`;

/**
 * The partner display names for a batch of leads, keyed `orgId \0 code`. One
 * query whatever the batch size (the board lists up to a page per column).
 */
export async function affiliatePartnerNames(
  leads: readonly { orgId: string | null; sourceName: string | null | undefined }[],
): Promise<Map<string, string>> {
  const byOrg = new Map<string, Set<string>>();
  for (const lead of leads) {
    const code = affiliateCodeOf(lead.sourceName);
    if (!code || !lead.orgId) continue;
    const codes = byOrg.get(lead.orgId) ?? new Set<string>();
    codes.add(code);
    byOrg.set(lead.orgId, codes);
  }
  const names = new Map<string, string>();
  if (byOrg.size === 0) return names;
  const partners = await prisma.affiliatePartner.findMany({
    where: { OR: [...byOrg].map(([orgId, codes]) => ({ orgId, code: { in: [...codes] } })) },
    select: { orgId: true, code: true, displayName: true },
  });
  for (const p of partners) names.set(pairKey(p.orgId, p.code), p.displayName);
  return names;
}

/** The partner name for one lead, from a map `affiliatePartnerNames` built. */
export function affiliatePartnerNameFor(
  names: ReadonlyMap<string, string>,
  lead: { orgId: string | null; sourceName: string | null | undefined },
): string | null {
  const code = affiliateCodeOf(lead.sourceName);
  if (!code || !lead.orgId) return null;
  return names.get(pairKey(lead.orgId, code)) ?? null;
}

/**
 * How many leads a partner brought, and how many records sit in each stage —
 * the partner portal's card. Counts only. A lead is the partner's when its
 * Source is `affiliate:<the partner's code>` in the partner's own org.
 */
export async function partnerLeadsByStage(partner: { orgId: string; code: string }): Promise<{ leads: number; byStage: Map<string, number> }> {
  const sourceWhere = { orgId: partner.orgId, name: affiliateSourceName(partner.code) };
  const [leads, stages] = await Promise.all([
    prisma.user.count({ where: { orgId: partner.orgId, role: 'MENTEE', source: sourceWhere } }),
    prisma.mentorshipRelation.groupBy({
      by: ['pipelineStatus'],
      where: { orgId: partner.orgId, mentee: { orgId: partner.orgId, source: sourceWhere } },
      _count: { _all: true },
    }),
  ]);
  return { leads, byStage: new Map(stages.map((s) => [s.pipelineStatus, s._count._all])) };
}
