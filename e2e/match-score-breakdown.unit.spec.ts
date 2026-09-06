// Unit tests for the match-score presentation rules (#1785). Pure node — no
// browser, no DB, no page (the component is not wired into a screen yet; the
// rules it renders from are testable regardless, same as the other
// `*.unit.spec.ts` files here).
//
// What is guarded: the tier thresholds (they decide the colour a coordinator
// reads a candidate by), the definition of a *blocking* row (a blocked pair is
// a different outcome from a low score and must never be rendered as one), the
// row order, and the top-factor pick that keeps compact mode from degenerating
// into a bare percentage — which the component's compliance note forbids.
import { test, expect } from '@playwright/test';
import {
  clampPct,
  fmtPoints,
  isBlockingRow,
  orderRuleRows,
  tierOf,
  topFactor,
} from '@/lib/matching/presentation';
import type { MatchBreakdownEntry, MatchRuleKind } from '@/lib/matching/types';
import { dictionaries } from '@/i18n/dictionaries';
import { locales } from '@/i18n/config';
import { MATCH_DIMENSIONS } from '@/lib/matching/types';

function entry(over: Partial<MatchBreakdownEntry> & { dimension: string }): MatchBreakdownEntry {
  return {
    kind: 'WEIGHTED' as MatchRuleKind,
    weight: 10,
    ratio: 1,
    contribution: 10,
    passed: true,
    detail: [],
    ...over,
  };
}

test('tier boundaries are inclusive at 70 and 40', () => {
  expect(tierOf(70, [])).toBe('strong');
  expect(tierOf(69, [])).toBe('partial');
  expect(tierOf(40, [])).toBe('partial');
  expect(tierOf(39, [])).toBe('weak');
  expect(tierOf(0, [])).toBe('weak');
  expect(tierOf(100, [])).toBe('strong');
});

test('a block outranks the score, however high', () => {
  // The whole point of the red tier: 100 points and still not suggestable.
  expect(tierOf(100, ['managerExclusion'])).toBe('blocked');
  expect(tierOf(0, ['managerExclusion'])).toBe('blocked');
});

test('clampPct never lets a non-finite score reach the ring', () => {
  // A rule set whose weights sum to 0 makes the engine divide by zero. Unguarded
  // that printed "NaN%" next to stroke-dashoffset="NaN", which browsers read as
  // 0 — a fully drawn ring, i.e. a 100%-looking match.
  expect(clampPct(NaN)).toBe(0);
  expect(clampPct(Infinity)).toBe(0);
  expect(clampPct(-Infinity)).toBe(0);
  expect(clampPct(-5)).toBe(0);
  expect(clampPct(140)).toBe(100);
  expect(clampPct(46.6)).toBe(47);
});

test('points are shown to one decimal at most', () => {
  expect(fmtPoints(12.4999)).toBe('12.5');
  expect(fmtPoints(12)).toBe('12');
  expect(fmtPoints(0)).toBe('0');
  expect(fmtPoints(NaN)).toBe('0');
});

test('only a failed hard rule on a blocked dimension is a blocking row', () => {
  const blocked = ['language'];
  const hardFail = entry({ dimension: 'language', kind: 'HARD_REQUIRE', passed: false, contribution: 0 });
  // Two rules can share a dimension; a weighted one that passed must not be
  // painted red just because a hard rule next to it blocked.
  const weightedPass = entry({ dimension: 'language', kind: 'WEIGHTED', passed: true, contribution: 8 });
  expect(isBlockingRow(hardFail, blocked)).toBe(true);
  expect(isBlockingRow(weightedPass, blocked)).toBe(false);
  expect(isBlockingRow(hardFail, [])).toBe(false);
});

test('blocking rows are hoisted above everything else, order otherwise preserved', () => {
  const skills = entry({ dimension: 'skills', contribution: 42 });
  const city = entry({ dimension: 'city', contribution: 4 });
  const manager = entry({
    dimension: 'managerExclusion',
    kind: 'HARD_EXCLUDE',
    passed: false,
    weight: 0,
    contribution: 0,
  });
  const rows = orderRuleRows([skills, city, manager], ['managerExclusion']);
  expect(rows.map((r) => r.dimension)).toEqual(['managerExclusion', 'skills', 'city']);
  expect(orderRuleRows([skills, city, manager], []).map((r) => r.dimension)).toEqual([
    'skills',
    'city',
    'managerExclusion',
  ]);
});

test('the top factor is the biggest contributor, passed or not', () => {
  // 42 of the 46 points came from `skills`; ranking only passed rules named
  // `city` — the 4-point one — as the explanation.
  const skills = entry({ dimension: 'skills', passed: false, ratio: 0.7, contribution: 42 });
  const city = entry({ dimension: 'city', passed: true, ratio: 0.4, contribution: 4 });
  expect(topFactor([skills, city])?.dimension).toBe('skills');
});

test('there is no top factor when nothing scored — the caller must name the tier', () => {
  expect(topFactor([])).toBeNull();
  expect(topFactor([entry({ dimension: 'skills', passed: false, contribution: 0 })])).toBeNull();
});

test('every locale carries the compliance footer and a violation for each dimension', () => {
  for (const locale of locales) {
    const m = dictionaries[locale].matchScore;
    // The footer is the contestability half of the surface; an empty string in
    // one locale would silently ship a number-only render there.
    expect(m.footer.length, `${locale} footer`).toBeGreaterThan(20);
    expect(m.percent, `${locale} percent`).toContain('{n}');
    expect(m.violationFallback, `${locale} violationFallback`).toContain('{name}');
    for (const dimension of MATCH_DIMENSIONS) {
      const violation = (m.violations as Record<string, string>)[dimension];
      const name = (m.dimensions as Record<string, string>)[dimension];
      expect(violation, `${locale}.violations.${dimension}`).toBeTruthy();
      expect(name, `${locale}.dimensions.${dimension}`).toBeTruthy();
    }
  }
});

test('exclusion dimensions are named neutrally, not as the satisfied condition', () => {
  // Regression guard: these labels are rendered as row headings while the
  // *violations* carry the reason. A label like "Not the direct manager" read
  // as the blocking reason asserted the opposite of what happened.
  for (const locale of locales) {
    const dims = dictionaries[locale].matchScore.dimensions as Record<string, string>;
    for (const negation of ['Not ', 'değil', 'Nicht ', 'Noch nie', 'eşleşmemiş']) {
      expect(dims.managerExclusion, `${locale}.managerExclusion`).not.toContain(negation);
      expect(dims.previousPairing, `${locale}.previousPairing`).not.toContain(negation);
    }
  }
});
