import { prisma } from '@/lib/prisma';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { orgWhere } from '@/lib/tenantFilter';
import { TRIAL_ACTIVE_STAGE_KEY } from '@/lib/programTemplates';
import { dropWindows, trialInactive, usageDropVerdict, usageSignalSettings } from '@/lib/usageRule';

// The Prisma half of the usage signals (#2449); the rule is src/lib/usageRule.ts.
// Read by the attention queue (src/lib/mentorAttention.ts) — the signals are two
// more reasons there, never a screen of their own, and they never move a stage.

export type UsageReason = 'usage_drop' | 'trial_inactive';

export type UsageNote = {
  /** False while the org has no usage row at all: no signal is computed. */
  feedConnected: boolean;
  /** The caller's accounts left out for too short a history. */
  noHistory: number;
  /** Accounts of the org whose usage dropped but that nobody actively owns. */
  unowned: number;
};

type RelationInput = { id: string; companyId: string | null; pipelineStatus: string; trialStartedAt: Date | null };

export async function usageSignalsFor(
  orgId: string,
  relations: readonly RelationInput[],
  now: Date = new Date(),
): Promise<{ reasons: Map<string, UsageReason[]>; note: UsageNote }> {
  const reasons = new Map<string, UsageReason[]>();
  const tenant = await orgWhere(orgId);
  const any = await prisma.companyUsage.findFirst({ where: tenant, select: { id: true } });
  if (!any) return { reasons, note: { feedConnected: false, noHistory: 0, unowned: 0 } };

  const settings = usageSignalSettings({
    thresholdPct: await resolveSettingRaw('usageDropThresholdPct', { orgId }),
    baselineDays: await resolveSettingRaw('usageBaselineDays', { orgId }),
    trialDays: await resolveSettingRaw('trialActivationDays', { orgId }),
  });
  const w = dropWindows(now, settings.baselineDays);
  const [recent, prior, first, owned] = await Promise.all([
    prisma.companyUsage.groupBy({ by: ['companyId'], where: { ...tenant, date: { gte: w.recent.from, lt: w.recent.to } }, _sum: { transactions: true } }),
    prisma.companyUsage.groupBy({ by: ['companyId'], where: { ...tenant, date: { gte: w.prior.from, lt: w.prior.to } }, _sum: { transactions: true } }),
    prisma.companyUsage.groupBy({ by: ['companyId'], where: tenant, _min: { date: true } }),
    prisma.mentorshipRelation.findMany({ where: { ...tenant, status: 'ACTIVE', companyId: { not: null } }, select: { companyId: true }, distinct: ['companyId'] }),
  ]);
  const sumOf = (rows: typeof recent, id: string) => rows.find((r) => r.companyId === id)?._sum.transactions ?? 0;
  const verdict = (companyId: string) =>
    usageDropVerdict({
      recent: sumOf(recent, companyId),
      prior: sumOf(prior, companyId),
      firstRowAt: first.find((r) => r.companyId === companyId)?._min.date ?? null,
      now,
      settings,
    });

  const add = (relationId: string, reason: UsageReason) => reasons.set(relationId, [...(reasons.get(relationId) ?? []), reason]);

  // Drops: every record of an account that is not in a trial.
  const noHistory = new Set<string>();
  for (const r of relations) {
    if (!r.companyId || r.pipelineStatus === TRIAL_ACTIVE_STAGE_KEY) continue;
    const v = verdict(r.companyId);
    if (v === 'drop') add(r.id, 'usage_drop');
    else if (v === 'insufficient_history') noHistory.add(r.companyId);
  }

  // Trials: no usage at all N days in. The baseline does not apply to them.
  const trials = relations.filter((r) => r.companyId && r.trialStartedAt && r.pipelineStatus === TRIAL_ACTIVE_STAGE_KEY);
  if (trials.length > 0) {
    const since = new Date(Math.min(...trials.map((r) => r.trialStartedAt!.getTime())));
    const rows = await prisma.companyUsage.findMany({
      where: { ...tenant, companyId: { in: trials.map((r) => r.companyId!) }, date: { gte: new Date(since.getTime() - 24 * 60 * 60 * 1000) } },
      select: { companyId: true, date: true, transactions: true },
    });
    for (const r of trials) {
      const startDay = Date.UTC(r.trialStartedAt!.getUTCFullYear(), r.trialStartedAt!.getUTCMonth(), r.trialStartedAt!.getUTCDate());
      const used = rows.filter((u) => u.companyId === r.companyId && u.date.getTime() >= startDay).reduce((s, u) => s + u.transactions, 0);
      if (trialInactive({ trialStartedAt: r.trialStartedAt, usageSinceStart: used, now, settings })) add(r.id, 'trial_inactive');
    }
  }

  // The org's dropping accounts with no ACTIVE owner: in nobody's queue, so counted.
  const ownedIds = new Set(owned.map((o) => o.companyId));
  const unowned = first.filter((f) => !ownedIds.has(f.companyId) && verdict(f.companyId) === 'drop').length;

  return { reasons, note: { feedConnected: true, noHistory: noHistory.size, unowned } };
}
