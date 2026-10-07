// The /admin/ai console's queries (#2030), server-only. Everything is scoped to
// ONE org — the admin's settings org, the same org whose `aiMonthlyQuota` the
// gate enforces (src/lib/aiGate.ts) — with `orgWhere()`, so the default org
// also owns legacy NULL-org rows exactly as the quota counter does. AiUsage is
// in TENANT_MODELS too, but the middleware binds nothing while
// MT_ENFORCE_ISOLATION is off, so the explicit filter is what protects today.
//
// Aggregates in SQL: one groupBy per month, one for the unpriced count, and
// two `skip`-indexed lookups per task for p50/p95. Never a findMany of the
// month — except the CSV export, which is the rows by definition and capped.

import { prisma } from '@/lib/prisma';
import { orgWhere, withinTenant } from '@/lib/tenantFilter';
import { periodRange } from '@/lib/meteringRules';
import { getAiQuota } from '@/lib/aiGate';
import { isAiConfigured, providerBreakerState, resolveModel } from '@/lib/ai/provider';
import { AI_TASKS, AI_TASK_IDS } from '@/lib/ai/tasks';
import { foldUsage, percentileIndex, type TaskUsage, type UsageTotals } from '@/lib/ai/consoleRules';

export interface MonthUsage {
  period: string;
  tasks: TaskUsage[];
  totals: UsageTotals;
}

async function monthWhere(orgId: string, period: string) {
  return withinTenant({ createdAt: periodRange(period) }, await orgWhere(orgId));
}

async function latencyPercentiles(orgId: string, period: string, task: string): Promise<{ p50: number | null; p95: number | null }> {
  // Answered calls only: a provider_error's latency is the time it took to fail.
  const where = withinTenant({ createdAt: periodRange(period), scope: task, outcome: { not: 'provider_error' }, latencyMs: { not: null } }, await orgWhere(orgId));
  const n = await prisma.aiUsage.count({ where });
  const at = async (p: number) => {
    const k = percentileIndex(n, p);
    if (k === null) return null;
    const row = await prisma.aiUsage.findFirst({ where, orderBy: [{ latencyMs: 'asc' }, { id: 'asc' }], skip: k, select: { latencyMs: true } });
    return row?.latencyMs ?? null;
  };
  return { p50: await at(0.5), p95: await at(0.95) };
}

export async function loadMonthUsage(orgId: string, period: string): Promise<MonthUsage> {
  const where = await monthWhere(orgId, period);
  const [groups, unpricedGroups] = await Promise.all([
    prisma.aiUsage.groupBy({
      by: ['scope', 'outcome'],
      where,
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costMicros: true },
    }),
    // Answered but unpriced: the model is not in the rate table (pricing.ts), so the spend is a floor.
    prisma.aiUsage.groupBy({ by: ['scope'], where: { ...where, costMicros: null, outcome: { not: 'provider_error' } }, _count: { _all: true } }),
  ]);
  const tasks = [...new Set(groups.map((g) => g.scope))];
  const latency = Object.fromEntries(await Promise.all(tasks.map(async (t) => [t, await latencyPercentiles(orgId, period, t)] as const)));
  const { tasks: rows, totals } = foldUsage(
    groups.map((g) => ({
      scope: g.scope,
      outcome: g.outcome,
      calls: g._count._all,
      inputTokens: g._sum.inputTokens ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      costMicros: g._sum.costMicros ?? 0,
    })),
    Object.fromEntries(unpricedGroups.map((g) => [g.scope, g._count._all])),
    latency,
  );
  return { period, tasks: rows, totals };
}

export const FLAG_WINDOW_DAYS = 30;

export async function loadAiStatus(orgId: string) {
  const since = new Date(Date.now() - FLAG_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [quota, flaggedCalls] = await Promise.all([
    getAiQuota(orgId),
    // The injection tripwire's hits (#2026): flagged, never blocked.
    prisma.aiUsage.count({ where: withinTenant({ createdAt: { gte: since }, flags: { not: null } }, await orgWhere(orgId)) }),
  ]);
  return {
    configured: isAiConfigured(),
    breaker: providerBreakerState(),
    quota: { quota: quota.quota, used: quota.used, remaining: quota.remaining },
    flaggedCalls,
    flagWindowDays: FLAG_WINDOW_DAYS,
    tasks: AI_TASK_IDS.map((id) => ({ id, label: AI_TASKS[id].label, audience: AI_TASKS[id].audience, tier: AI_TASKS[id].tier, model: resolveModel(id) })),
  };
}

/** The CSV export: one month's rows, newest first, capped. No user id, no content — the meter only. */
export const CSV_ROW_CAP = 50_000;

export async function loadMonthRows(orgId: string, period: string) {
  return prisma.aiUsage.findMany({
    where: await monthWhere(orgId, period),
    orderBy: { createdAt: 'desc' },
    take: CSV_ROW_CAP,
    select: { createdAt: true, scope: true, outcome: true, model: true, inputTokens: true, outputTokens: true, costMicros: true, latencyMs: true, flags: true },
  });
}
