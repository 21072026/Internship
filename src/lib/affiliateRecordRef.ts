// Which affiliate record a support question points at (docs/affiliate-module.md,
// #3353). Server-only. The format is src/lib/affiliateRecordRefRule.ts.
//
// Writing: a partner may attach only a row of its OWN — the same
// `{ orgId, partnerId }` scope every portal read uses (affiliateRowScope); any
// other id reads as unknown. Reading: the admin's support screen gets a short,
// org-scoped description of each referenced row; a row that no longer exists
// (or another org's) simply has none.

import { prisma } from '@/lib/prisma';
import { parseRecordRef, recordRef, type RecordKind, type RecordSummary } from '@/lib/affiliateRecordRefRule';

export type { RecordSummary };

/** The canonical reference and its summary when the row is this partner's; null otherwise. */
export async function ownRecord(scope: { orgId: string; partnerId: string }, raw: unknown): Promise<{ ref: string; summary: RecordSummary } | null> {
  const parsed = parseRecordRef(raw);
  if (!parsed) return null;
  const summary = (await summarise(scope, [parsed])).get(recordRef(parsed.kind, parsed.id));
  return summary ? { ref: recordRef(parsed.kind, parsed.id), summary } : null;
}

/** Summaries of the given references inside one organisation (any partner). */
export async function describeRecords(orgId: string, refs: readonly (string | null | undefined)[]): Promise<Map<string, RecordSummary>> {
  const parsed = refs.map(parseRecordRef).filter((p): p is NonNullable<typeof p> => p !== null);
  return parsed.length ? summarise({ orgId }, parsed) : new Map();
}

async function summarise(scope: { orgId: string; partnerId?: string }, refs: { kind: RecordKind; id: string }[]): Promise<Map<string, RecordSummary>> {
  const ids = (kind: RecordKind) => [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))];
  const [commissions, customers] = await Promise.all([
    ids('commission').length
      ? prisma.affiliateCommission.findMany({
          where: { ...scope, id: { in: ids('commission') } },
          select: { id: true, amountMinor: true, currency: true, status: true, customer: { select: { externalRef: true } } },
        })
      : [],
    ids('customer').length
      ? prisma.affiliateCustomer.findMany({ where: { ...scope, id: { in: ids('customer') } }, select: { id: true, externalRef: true } })
      : [],
  ]);
  const out = new Map<string, RecordSummary>();
  for (const c of commissions) {
    out.set(recordRef('commission', c.id), { kind: 'commission', customerRef: c.customer.externalRef, amountMinor: c.amountMinor, currency: c.currency, status: c.status });
  }
  for (const c of customers) {
    out.set(recordRef('customer', c.id), { kind: 'customer', customerRef: c.externalRef, amountMinor: null, currency: null, status: null });
  }
  return out;
}
