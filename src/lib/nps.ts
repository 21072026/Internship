// Net Promoter Score (#1910) — pure, client-safe. Standard bands: 9–10
// promoter, 7–8 passive, 0–6 detractor; the score is % promoters − %
// detractors, a whole number from −100 to 100. Below the response floor
// (src/lib/surveyPrivacy.ts) there is no score at all: "not enough responses"
// is the answer, never a number from three people.

import { applyResponseFloor, effectiveMinResponses } from '@/lib/surveyPrivacy';

export interface NpsResult {
  suppressed: false;
  n: number;
  promoters: number;
  passives: number;
  detractors: number;
  /** −100..100, rounded once. */
  score: number;
}

export type Nps = NpsResult | { suppressed: true; n: number };

/** Bands for one 0–10 answer, or null for anything that is not one. */
export function npsBand(value: unknown): 'promoter' | 'passive' | 'detractor' | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10) return null;
  return value >= 9 ? 'promoter' : value >= 7 ? 'passive' : 'detractor';
}

export function npsFromScores(scores: unknown[], minResponses?: number | null): Nps {
  let promoters = 0;
  let passives = 0;
  let detractors = 0;
  for (const s of scores) {
    const band = npsBand(s);
    if (band === 'promoter') promoters++;
    else if (band === 'passive') passives++;
    else if (band === 'detractor') detractors++;
  }
  const n = promoters + passives + detractors;
  // The count of a suppressed group is itself shown — it is what tells an
  // admin how far from the floor they are, and the floor already hides who.
  if (n < effectiveMinResponses(minResponses)) return { suppressed: true, n };
  return { suppressed: false, n, promoters, passives, detractors, score: Math.round(((promoters - detractors) / n) * 100) };
}

export interface NpsPoint {
  period: string;
  /** null = hidden: under the floor, or hidden with one that is (residual). */
  nps: NpsResult | null;
}

/**
 * NPS per period (e.g. ISO week), oldest first. The periods are a breakdown
 * like any other — next to the overall score, a lone hidden week could be
 * recovered by subtraction — so they go through applyResponseFloor, residual
 * included, and a hidden period carries no count.
 */
export function npsTrend(series: { period: string; value: unknown }[], minResponses?: number | null): NpsPoint[] {
  const byPeriod = new Map<string, unknown[]>();
  for (const s of series) if (npsBand(s.value)) byPeriod.set(s.period, [...(byPeriod.get(s.period) ?? []), s.value]);
  const floored = applyResponseFloor(
    [...byPeriod.entries()].map(([key, values]) => ({ key, n: values.length, data: npsFromScores(values, minResponses) })),
    minResponses,
  );
  return floored
    .map((b) => ({ period: b.key, nps: !b.suppressed && b.data && !b.data.suppressed ? b.data : null }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

/** The ISO week a date falls in, as `YYYY-Www` — the trend's period key. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
