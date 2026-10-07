// Unit tests for structured offer compensation (#1851).
// Run: node --test --experimental-strip-types scripts/test/compensation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCHMARK_MIN_BUCKET,
  OFFER_CURRENCIES,
  benchmarkBuckets,
  benchmarkStats,
  hasStructuredCompensation,
  normalizePosition,
  normalizeToMonthlyMinor,
  quantileSorted,
  validateCompensation,
} from '../../src/lib/compensation.ts';

test('the currency list is the closed two-decimal set', () => {
  assert.deepEqual([...OFFER_CURRENCIES], ['EUR', 'TRY', 'USD', 'CHF', 'GBP']);
});

test('validation: an amount needs a currency and a period, a bonus needs a currency', () => {
  assert.equal(validateCompensation({}), null);
  assert.equal(validateCompensation({ baseAmountMinor: 450_000 }), 'currency_required');
  assert.equal(validateCompensation({ baseAmountMinor: 450_000, currency: 'EUR' }), 'period_required');
  assert.equal(validateCompensation({ baseAmountMinor: 450_000, currency: 'EUR', basePeriod: 'MONTHLY' }), null);
  assert.equal(validateCompensation({ signingBonusMinor: 100_000 }), 'currency_required');
  assert.equal(validateCompensation({ signingBonusMinor: 100_000, currency: 'TRY' }), null);
  assert.equal(validateCompensation({ currency: 'JPY' }), 'unknown_currency');
  assert.equal(validateCompensation({ currency: 'EUR', basePeriod: 'WEEKLY' }), 'unknown_period');
  assert.equal(validateCompensation({ contractType: 'FREELANCE' }), 'unknown_contract_type');
  // A contract type or a note alone is fine — no money, no currency needed.
  assert.equal(validateCompensation({ contractType: 'INTERNSHIP', hoursPerWeek: 20 }), null);
});

test('hasStructuredCompensation ignores the free-text note', () => {
  assert.equal(hasStructuredCompensation(null), false);
  assert.equal(hasStructuredCompensation({}), false);
  assert.equal(hasStructuredCompensation({ currency: 'EUR' }), false);
  assert.equal(hasStructuredCompensation({ baseAmountMinor: 1 }), true);
  assert.equal(hasStructuredCompensation({ contractType: 'PERMANENT' }), true);
  assert.equal(hasStructuredCompensation({ equityNote: '0.1 %' }), true);
});

test('normalizeToMonthlyMinor: monthly as is, yearly ÷ 12, hourly × hours × 52 ÷ 12', () => {
  assert.equal(normalizeToMonthlyMinor({ baseAmountMinor: 450_000, basePeriod: 'MONTHLY', hoursPerWeek: null }), 450_000);
  assert.equal(normalizeToMonthlyMinor({ baseAmountMinor: 5_400_000, basePeriod: 'YEARLY', hoursPerWeek: null }), 450_000);
  // €15.00/h × 40 h × 52 ÷ 12 = €2 600.00
  assert.equal(normalizeToMonthlyMinor({ baseAmountMinor: 1_500, basePeriod: 'HOURLY', hoursPerWeek: 40 }), 260_000);
  // Rounded to a whole minor unit, half away from zero: 5 000 001 ÷ 12 = 416 666.75
  assert.equal(normalizeToMonthlyMinor({ baseAmountMinor: 5_000_001, basePeriod: 'YEARLY', hoursPerWeek: null }), 416_667);
});

test('normalizeToMonthlyMinor refuses to guess', () => {
  assert.equal(normalizeToMonthlyMinor({ baseAmountMinor: null, basePeriod: 'MONTHLY', hoursPerWeek: null }), null);
  assert.equal(normalizeToMonthlyMinor({ baseAmountMinor: 1_500, basePeriod: null, hoursPerWeek: 40 }), null);
  // An hourly rate without the hours is not "assume 40".
  assert.equal(normalizeToMonthlyMinor({ baseAmountMinor: 1_500, basePeriod: 'HOURLY', hoursPerWeek: null }), null);
  assert.equal(normalizeToMonthlyMinor({ baseAmountMinor: 1_500, basePeriod: 'HOURLY', hoursPerWeek: 0 }), null);
  assert.equal(normalizeToMonthlyMinor({ baseAmountMinor: 1_500, basePeriod: 'WEEKLY', hoursPerWeek: 40 }), null);
});

test('quantileSorted interpolates between order statistics', () => {
  assert.equal(quantileSorted([10], 0.5), 10);
  assert.equal(quantileSorted([10, 20], 0.5), 15);
  assert.equal(quantileSorted([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantileSorted([1, 2, 3, 4, 5], 0.25), 2);
  assert.equal(quantileSorted([1, 2, 3, 4, 5], 0.75), 4);
  assert.equal(quantileSorted([100, 200, 300, 400], 0.25), 175);
  assert.ok(Number.isNaN(quantileSorted([], 0.5)));
});

test('benchmarkStats suppresses below the floor and reports it', () => {
  assert.equal(BENCHMARK_MIN_BUCKET, 5);
  const four = benchmarkStats([1, 2, 3, 4]);
  assert.deepEqual(four, { count: 4, medianMonthlyMinor: null, p25MonthlyMinor: null, p75MonthlyMinor: null, suppressed: true });
  const five = benchmarkStats([500_000, 300_000, 400_000, 450_000, 350_000]);
  assert.deepEqual(five, { count: 5, medianMonthlyMinor: 400_000, p25MonthlyMinor: 350_000, p75MonthlyMinor: 450_000, suppressed: false });
});

test('benchmarkBuckets: one position in one currency is one bucket, never mixed', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push({ position: ` Frontend   Developer${i % 2 ? '' : ' '}`, currency: 'eur', contractType: 'PERMANENT', monthlyMinor: 400_000 + i * 10_000 });
  rows.push({ position: 'Frontend Developer', currency: 'TRY', contractType: 'PERMANENT', monthlyMinor: 9_000_000 });
  rows.push({ position: 'Data Analyst', currency: 'EUR', contractType: null, monthlyMinor: 380_000 });
  rows.push({ position: '   ', currency: 'EUR', contractType: null, monthlyMinor: 1 });

  const buckets = benchmarkBuckets(rows);
  assert.deepEqual(buckets.map((b) => [b.position, b.currency, b.count, b.suppressed]), [
    ['data analyst', 'EUR', 1, true],
    ['frontend developer', 'EUR', 5, false],
    ['frontend developer', 'TRY', 1, true],
  ]);
  assert.equal(buckets[1].medianMonthlyMinor, 420_000);
  assert.equal('contractType' in buckets[1], false);

  const byType = benchmarkBuckets(rows, { byContractType: true });
  assert.equal(byType.find((b) => b.position === 'data analyst')?.contractType, null);
  assert.equal(byType.find((b) => b.position === 'frontend developer' && b.currency === 'EUR')?.contractType, 'PERMANENT');
});

test('normalizePosition folds case and whitespace', () => {
  assert.equal(normalizePosition('  Backend   Engineer '), 'backend engineer');
});
