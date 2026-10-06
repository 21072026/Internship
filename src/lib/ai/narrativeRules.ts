// The rules around the analytics "what changed" paragraph (#2046) — pure, no
// provider, unit-tested with a golden case (scripts/test/narrative-rules.test.mjs).
//
//   • WHAT LEAVES: the figures the dashboard already shows, as plain
//     `label: value` lines — aggregates and stage labels only. No mentor
//     workload rows (they carry names), no ids.
//   • WHAT COMES BACK is checked, not trusted: every number the paragraph
//     cites must be a number that was in the facts. A computed percentage, a
//     rounded figure, a guessed year — anything the input did not contain —
//     rejects the whole paragraph. A narrative that cites one invented figure
//     is not a narrative with one error; it is one nobody can rely on.

import type { AdminAnalytics } from '@/lib/adminAnalyticsData';

export interface Fact {
  label: string;
  value: string | number;
}

/** The figures a narrative may use, in the order a reader would scan them. */
export function analyticsFacts(a: AdminAnalytics, label: (stageKey: string) => string): Fact[] {
  const facts: Fact[] = [
    { label: 'Date range of the time-based figures', value: `${a.range.from} to ${a.range.to}` },
    { label: 'Pairings in the pipeline now (all time)', value: a.totalRelations },
    { label: `Share of pairings at the "${a.finishedLabel}" stage now, in percent`, value: a.conversionToHired },
  ];
  for (const [key, n] of Object.entries(a.funnel).sort((x, y) => y[1] - x[1])) {
    facts.push({ label: `Pairings at stage "${label(key)}" now`, value: n });
  }
  facts.push({ label: 'Interactions logged in the date range', value: a.engagement.interactions });
  facts.push({ label: 'Meetings in the date range', value: a.engagement.meetings });
  if (a.rsvp.acceptanceRate !== null) facts.push({ label: 'Meeting invitations accepted, in percent of those answered', value: a.rsvp.acceptanceRate });
  a.trends.months.forEach((m, i) => {
    facts.push({ label: `New pairings started in ${m}`, value: a.trends.newRelations[i] });
    facts.push({ label: `Interactions logged in ${m}`, value: a.trends.interactions[i] });
  });
  for (const w of a.signupFunnel) {
    facts.push({ label: `Sign-ups in the last ${w.days} days`, value: w.registered });
    facts.push({ label: `Of those, e-mail verified (last ${w.days} days)`, value: w.verified });
    facts.push({ label: `Of those, active (last ${w.days} days)`, value: w.active });
  }
  return facts;
}

export function factsText(facts: Fact[]): string {
  return facts.map((f) => `- ${f.label}: ${f.value}`).join('\n');
}

const NUMBER = /\d+(?:[.,]\d+)*/g;

/**
 * Every reading of a number token a reader could mean: as typed, with the
 * separators dropped (1,234 / 1.234), and with a decimal comma (12,5).
 */
function readings(token: string): number[] {
  const out = new Set<number>([Number(token.replace(/[.,]/g, ''))]);
  if (/^\d+[.,]\d+$/.test(token)) out.add(Number(token.replace(',', '.')));
  return [...out].filter((n) => Number.isFinite(n));
}

/** The numbers a narrative may cite: every number that appears anywhere in the facts. */
export function allowedNumbers(facts: Fact[]): Set<number> {
  const allowed = new Set<number>();
  for (const token of factsText(facts).match(NUMBER) ?? []) for (const n of readings(token)) allowed.add(n);
  return allowed;
}

/** The numbers in `text` that the facts do not contain — empty means grounded. */
export function ungroundedNumbers(text: string, facts: Fact[]): string[] {
  const allowed = allowedNumbers(facts);
  return (text.match(NUMBER) ?? []).filter((token) => !readings(token).some((n) => allowed.has(n)));
}

/** The paragraph as kept: trimmed, bounded, and null when it cites anything it was not given. */
export function acceptNarrative(text: string, facts: Fact[]): string | null {
  const clean = text.trim().replace(/\n{3,}/g, '\n\n').slice(0, 1500);
  if (!clean) return null;
  return ungroundedNumbers(clean, facts).length === 0 ? clean : null;
}
