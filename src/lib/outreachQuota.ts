// The company's monthly outreach quota (#1840): requests APPROVED per company
// per calendar month (UTC) — a channel the candidate later revoked still
// counts, it was granted, counted from CandidateOutreach. The limit is the
// company's own `Company.quota` when an admin set one, else the org's
// `outreachMonthlyQuota` setting. Enforced when a company ASKS — never when a
// mentor approves or a message is sent, so a candidate's thread is never cut
// off mid-conversation by a meter. The plan-level meter is the commercial
// epic's (#1727); this is the per-company lever.

import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { quotaLimit, quotaPeriod } from '@/lib/outreachRule';

export async function outreachQuota(orgId: string, companyId: string, now = new Date()): Promise<{ limit: number; used: number }> {
  const { start, end } = quotaPeriod(now);
  const [company, setting, used] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { quota: true } }),
    getSetting('outreachMonthlyQuota', orgId),
    prisma.candidateOutreach.count({ where: { orgId, companyId, status: { in: ['APPROVED', 'REVOKED'] }, decidedAt: { gte: start, lt: end } } }),
  ]);
  return { limit: quotaLimit(company?.quota ?? null, setting), used };
}
