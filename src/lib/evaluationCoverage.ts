// Evaluation coverage (#1891, read by the scorecard's `evaluationCoverage`,
// #1908) — server-only, and deliberately not in evaluationDue.ts: that module
// sends mail through emailService, and the scorecard must not pull the mail
// stack into every analytics request.

import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Of the evaluations that fell due in the window — and are at least a week
 * past due, so both reminders have had their chance — how many were written.
 */
export async function evaluationCoverage(tenant: TenantWhere, now = new Date(), windowDays = 90): Promise<{ due: number; written: number }> {
  const where = withinTenant({ dueAt: { gte: new Date(now.getTime() - windowDays * DAY), lte: new Date(now.getTime() - 7 * DAY) } }, tenant);
  const [due, written] = await Promise.all([
    prisma.evaluationDue.count({ where }),
    prisma.evaluationDue.count({ where: { AND: [where, { completedAt: { not: null } }] } }),
  ]);
  return { due, written };
}
