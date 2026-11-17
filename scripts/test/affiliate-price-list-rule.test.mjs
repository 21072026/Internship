// Unit tests for the transaction price list (src/lib/affiliatePriceListRule.ts,
// docs/affiliate-module.md § Commission base, #3843).
//
// Run: npm run test:unit
//
// Synthetic price lists only — no number here mirrors a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { parsePriceList, listPriceMinor, netMilli, canonicalPriceList, readStoredPriceList, MAX_PRICE_STEPS } = await import(
  '../../src/lib/affiliatePriceListRule.ts'
);

// 5 free, a 5.00 base fee covering the first 6, then 0.10 up to 50, 0.04 up to
// 500 and 0.025 beyond; 20 % VAT.
const LIST = {
  freeUpTo: 5,
  baseCovers: 6,
  baseFeeMilli: 500_000,
  steps: [
    { upTo: 50, unitMilli: 10_000 },
    { upTo: 500, unitMilli: 4_000 },
    { upTo: null, unitMilli: 2_500 },
  ],
  vatBps: 2_000,
  reverseChargeAddsVat: true,
};
const NO_VAT = { ...LIST, vatBps: 0 };

const priceOf = (list, n, opts) => {
  const r = listPriceMinor(list, n, opts);
  assert.equal(r.ok, true, `count ${n}`);
  return r.amountMinor;
};

test('a valid list parses unchanged', () => {
  assert.deepEqual(parsePriceList(LIST), { ok: true, priceList: LIST });
});

test('up to the free limit a month costs nothing', () => {
  assert.equal(priceOf(LIST, 1), 0);
  assert.equal(priceOf(LIST, 5), 0);
});

test('the base fee covers the first transactions above the free limit', () => {
  assert.equal(priceOf(NO_VAT, 6), 500);
  // 7th transaction is the first of step one.
  assert.equal(priceOf(NO_VAT, 7), 510);
  assert.equal(priceOf(NO_VAT, 50), 500 + 44 * 10);
});

test('the steps add up across every boundary', () => {
  assert.equal(priceOf(NO_VAT, 51), 940 + 4);
  assert.equal(priceOf(NO_VAT, 500), 940 + 450 * 4);
  // 501st is the first of the open-ended step: 27.40 + 0.025.
  assert.equal(netMilli(NO_VAT, 501), 2_740_000n + 2_500n);
});

test('a fractional price is rounded once, at the end, half up', () => {
  // 501 → 27.425 → 27.43; 502 → 27.45; 503 → 27.475 → 27.48; 504 → 27.50.
  assert.equal(priceOf(NO_VAT, 501), 2_743);
  assert.equal(priceOf(NO_VAT, 502), 2_745);
  assert.equal(priceOf(NO_VAT, 503), 2_748);
  // Rounding each transaction (0.03) would have given 27.52.
  assert.equal(priceOf(NO_VAT, 504), 2_750);
});

test('VAT is added before the one rounding', () => {
  // net 5.10 → gross 6.12.
  assert.equal(priceOf(LIST, 7), 612);
  // net 27.425 × 1.2 = 32.91.
  assert.equal(priceOf(LIST, 501), 3_291);
  // net 27.475 × 1.2 = 32.97.
  assert.equal(priceOf(LIST, 503), 3_297);
  // 5.10 × 1.19 = 6.069 → 6.07.
  assert.equal(priceOf({ ...LIST, vatBps: 1_900 }, 7), 607);
});

test('reverse charge: VAT follows the programme setting', () => {
  assert.equal(priceOf(LIST, 7, { reverseCharge: true }), 612);
  const without = { ...LIST, reverseChargeAddsVat: false };
  assert.equal(priceOf(without, 7, { reverseCharge: true }), 510);
  assert.equal(priceOf(without, 7, { reverseCharge: false }), 612);
});

test('a free limit of 0 and a base fee covering a single transaction', () => {
  const list = { ...NO_VAT, freeUpTo: 0, baseCovers: 1, steps: [{ upTo: null, unitMilli: 1_000 }] };
  assert.equal(priceOf(list, 1), 500);
  assert.equal(priceOf(list, 2), 501);
});

test('a huge count stays exact', () => {
  const r = listPriceMinor(NO_VAT, 90_000_000);
  assert.equal(r.ok, true);
  // 2740.00 + (90 000 000 − 500) × 0.025
  assert.equal(r.amountMinor, 274_000 / 100 + (90_000_000 - 500) * 2.5);
});

test('an invalid count is refused', () => {
  for (const n of [0, -1, 1.5, Number.NaN, 100_000_001]) assert.deepEqual(listPriceMinor(LIST, n), { ok: false, issue: 'transaction_count' });
});

test('an amount over the column bound is refused', () => {
  const list = { ...NO_VAT, steps: [{ upTo: null, unitMilli: 100_000_000_000 }] };
  assert.deepEqual(listPriceMinor(list, 1_000), { ok: false, issue: 'amount_range' });
});

test('every problem is reported at once', () => {
  const r = parsePriceList({ freeUpTo: 6, baseCovers: 6, baseFeeMilli: -1, steps: [{ upTo: 3, unitMilli: 1 }, { upTo: 10, unitMilli: 'x' }], vatBps: 20_000 });
  assert.equal(r.ok, false);
  const got = r.issues.map((i) => `${i.field}:${i.code}`).sort();
  assert.deepEqual(got, [
    'baseCovers:order',
    'baseFeeMilli:range',
    'reverseChargeAddsVat:required',
    'steps.0.upTo:order',
    'steps.1.unitMilli:type',
    'steps.1.upTo:type',
    'vatBps:range',
  ]);
});

test('steps: required, at least one, at most the limit, ascending', () => {
  const { steps, ...rest } = LIST;
  assert.deepEqual(parsePriceList(rest).issues, [{ field: 'steps', code: 'required' }]);
  assert.deepEqual(parsePriceList({ ...rest, steps: [] }).issues, [{ field: 'steps', code: 'range' }]);
  const many = Array.from({ length: MAX_PRICE_STEPS + 1 }, (_, i) => ({ upTo: i === MAX_PRICE_STEPS ? null : 10 * (i + 1), unitMilli: 1 }));
  assert.deepEqual(parsePriceList({ ...rest, steps: many }).issues, [{ field: 'steps', code: 'range' }]);
  const unordered = [{ upTo: 100, unitMilli: 1 }, { upTo: 100, unitMilli: 1 }, { upTo: null, unitMilli: 1 }];
  assert.deepEqual(parsePriceList({ ...rest, steps: unordered }).issues, [{ field: 'steps.1.upTo', code: 'order' }]);
  assert.equal(steps.length, 3);
});

test('a stored value that does not parse reads as no price list', () => {
  assert.equal(readStoredPriceList(null), null);
  assert.equal(readStoredPriceList({ freeUpTo: 'x' }), null);
  assert.deepEqual(readStoredPriceList(LIST), LIST);
});

test('canonical form compares by value, not key order', () => {
  const shuffled = { reverseChargeAddsVat: true, vatBps: 2_000, steps: LIST.steps, baseFeeMilli: 500_000, baseCovers: 6, freeUpTo: 5 };
  assert.equal(canonicalPriceList(parsePriceList(shuffled).priceList), canonicalPriceList(LIST));
  assert.notEqual(canonicalPriceList({ ...LIST, vatBps: 1_900 }), canonicalPriceList(LIST));
  assert.equal(canonicalPriceList(null), 'null');
});
