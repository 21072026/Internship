// The internal ROI report's data load (#1895) — everything /admin/analytics/roi
// needs from the database, handed to the one ROI model (src/lib/roi.ts,
// #1892), which stays Prisma-free so the public calculator (#1755) can share
// it. This file decides WHICH rows fall in a window; roi.ts decides what they
// add up to.
//
// THE TWO SELECTION RULES (docs/roi.md):
//
//   Costs — every ProgramCost line whose period OVERLAPS the window counts IN
//   FULL. That is the ledger's own contract (prisma/schema.prisma, "additive by
//   construction"): no proration, so every figure on the screen is a sum of
//   rows an admin can open and check. An annual line seen through a one-month
//   window therefore reads as the whole year's spend — the screen says so.
//
//   Placements — a relation is placed in the window when its Placement row's
//   `placedAt` falls in it and it is not reversed, or, for a relation with no
//   Placement row (hires from before the #1765 stamp existed), when it FIRST
//   entered the tenant's resolved finished stage (#1882 `outcomeStageKeys`)
//   inside the window. "First" so a relation that bounced out and back in is
//   one hire, not two, and a hire from last year that is touched again this
//   year is not counted again. Value comes only from a Placement row; a
//   relation without one is valued from the assumption set, and the result
//   says how many were.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { outcomeStageKeys } from '@/lib/pipelineStages';
import type { Locale } from '@/i18n/config';
import {
  computeRoi,
  normaliseCurrency,
  DEFAULT_ASSUMPTIONS,
  type RoiAssumptions,
  type RoiPlacementInput,
  type RoiResult,
} from '@/lib/roi';

export interface RoiQuery {
  /** Inclusive calendar days, YYYY-MM-DD. */
  from: string;
  to: string;
  cohortId: string | null;
  /** Keep only cost lines in this currency (the answer to a mixed-currency window). */
  currency: string | null;
  assumptions: Partial<Omit<RoiAssumptions, 'currency'>>;
  mentorHours: number;
}

export interface RoiCostGroup {
  category: string;
  amountMinor: number;
  lines: number;
}

export interface RoiReport {
  result: RoiResult;
  /** Cost lines in the window, by category, in the result's currency. */
  costsByCategory: RoiCostGroup[];
  /** Every currency the window's cost lines carry — more than one is the mixed-currency case. */
  costCurrencies: string[];
  placementSources: { ledger: number; stage: number };
  finishedLabel: string;
}

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export async function loadRoiReport(tenant: TenantWhere, settingsOrgId: string, locale: Locale, q: RoiQuery): Promise<RoiReport> {
  const from = day(q.from);
  const toDay = day(q.to);
  const toExclusive = new Date(toDay.getTime() + 24 * 60 * 60 * 1000);
  const relationScope: Prisma.MentorshipRelationWhereInput = withinTenant(q.cohortId ? { cohortId: q.cohortId } : {}, tenant);

  const allCosts = await prisma.programCost.findMany({
    where: withinTenant({ periodStart: { lte: toDay }, periodEnd: { gte: from }, ...(q.cohortId ? { cohortId: q.cohortId } : {}) }, tenant),
    select: { category: true, amountMinor: true, currency: true },
  });
  const costCurrencies = [...new Set(allCosts.map((c) => normaliseCurrency(c.currency)))].sort();
  const costs = q.currency ? allCosts.filter((c) => normaliseCurrency(c.currency) === q.currency) : allCosts;

  const outcome = await outcomeStageKeys(settingsOrgId, locale);
  const [ledgerRows, entries] = await Promise.all([
    prisma.placement.findMany({
      where: withinTenant({ placedAt: { gte: from, lt: toExclusive }, relation: relationScope }, tenant),
      select: { relationId: true, valueMinor: true, valueCurrency: true, feeMinor: true, feeCurrency: true, reversedAt: true },
    }),
    outcome.finished.length === 0
      ? Promise.resolve([] as { relationId: string }[])
      : prisma.statusChange.findMany({
          where: { toStatus: { in: outcome.finished }, createdAt: { gte: from, lt: toExclusive }, relation: relationScope },
          select: { relationId: true },
          distinct: ['relationId'],
        }),
  ]);
  // A reversed placement (#1765) is a hire that was undone: it is not counted,
  // and — being ledgered — its relation is not counted from the stage trail
  // either.
  const ledger = ledgerRows.filter((p) => !p.reversedAt);
  const ledgerIds = new Set(ledgerRows.map((p) => p.relationId));
  const candidates = entries.map((e) => e.relationId).filter((id) => !ledgerIds.has(id));
  // Keep only relations whose FIRST entry into the finished stage is in the window.
  const earlier = candidates.length
    ? await prisma.statusChange.findMany({
        where: { relationId: { in: candidates }, toStatus: { in: outcome.finished }, createdAt: { lt: from } },
        select: { relationId: true },
        distinct: ['relationId'],
      })
    : [];
  // …and that have no Placement row OUTSIDE the window either: a ledgered hire
  // is dated by its ledger row, never twice.
  const ledgeredElsewhere = candidates.length
    ? await prisma.placement.findMany({ where: { relationId: { in: candidates } }, select: { relationId: true } })
    : [];
  const excluded = new Set([...earlier, ...ledgeredElsewhere].map((r) => r.relationId));
  const stageOnly = candidates.filter((id) => !excluded.has(id));

  const placements: RoiPlacementInput[] = [
    ...ledger.map((p) => ({ valueMinor: p.valueMinor, valueCurrency: p.valueCurrency, feeMinor: p.feeMinor, feeCurrency: p.feeCurrency })),
    ...stageOnly.map(() => ({ valueMinor: null })),
  ];

  // The assumptions are denominated in the window's own currency: the one the
  // admin picked, else the one every cost line shares, else the first recorded
  // placement value's, else the model's default. A window that really mixes
  // currencies still fails in computeRoi — with the list — rather than being
  // silently summed.
  const currency =
    q.currency ??
    (costCurrencies.length === 1 ? costCurrencies[0] : null) ??
    ledger.map((p) => (p.valueMinor != null ? p.valueCurrency : null)).find((c): c is string => !!c)?.toUpperCase() ??
    DEFAULT_ASSUMPTIONS.currency;

  const result = computeRoi({
    costs: costs.map((c) => ({ category: c.category, amountMinor: c.amountMinor, currency: c.currency })),
    placements,
    assumptions: { ...q.assumptions, currency },
    mentorHours: q.mentorHours,
    window: { startIso: from.toISOString(), endIso: toDay.toISOString() },
  });

  const groups = new Map<string, RoiCostGroup>();
  for (const c of costs) {
    const g = groups.get(c.category) ?? { category: c.category, amountMinor: 0, lines: 0 };
    g.amountMinor += c.amountMinor;
    g.lines += 1;
    groups.set(c.category, g);
  }

  return {
    result,
    costsByCategory: [...groups.values()].sort((a, b) => b.amountMinor - a.amountMinor),
    costCurrencies,
    placementSources: { ledger: ledger.length, stage: stageOnly.length },
    finishedLabel: outcome.finishedLabel,
  };
}
