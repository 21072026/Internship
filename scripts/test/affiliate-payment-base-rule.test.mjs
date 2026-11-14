// Unit tests for the commission base of an affiliate payment
// (src/lib/affiliatePaymentBaseRule.ts, docs/affiliate-module.md § Commission base, #3552).
//
// Run: npm run test:unit
//
// Synthetic amounts only. The question here is which input shape wins and when
// a payment is refused before the writer takes a lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// affiliatePaymentBaseRule.ts imports its sibling without an extension; see ts-extensionless-resolve.mjs.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { MAX_AMOUNT_MINOR } = await import('../../src/lib/affiliateCommissionRule.ts');
const { resolvePaymentBase } = await import('../../src/lib/affiliatePaymentBaseRule.ts');

test('a bare amount is the base, with no breakdown', () => {
  assert.deepEqual(resolvePaymentBase({ amountMinor: 4_900 }), { ok: true, amountMinor: 4_900, transactionCount: null, unitPriceMinor: null });
  // Its range is still the shape check's job (issue `amount`), exactly as before.
  assert.deepEqual(resolvePaymentBase({ amountMinor: 0 }), { ok: true, amountMinor: 0, transactionCount: null, unitPriceMinor: null });
  assert.deepEqual(resolvePaymentBase({ amountMinor: 1_000, transactionCount: null, unitPriceMinor: undefined }).ok, true);
});

test('a breakdown alone: the base is count × unit price, and the breakdown is kept', () => {
  assert.deepEqual(resolvePaymentBase({ transactionCount: 120, unitPriceMinor: 35 }), {
    ok: true,
    amountMinor: 4_200,
    transactionCount: 120,
    unitPriceMinor: 35,
  });
});

test('both shapes together must agree', () => {
  assert.deepEqual(resolvePaymentBase({ amountMinor: 4_200, transactionCount: 120, unitPriceMinor: 35 }).ok, true);
  assert.deepEqual(resolvePaymentBase({ amountMinor: 3_990, transactionCount: 120, unitPriceMinor: 35 }), { ok: false, issue: 'amount_mismatch' });
});

test('nothing given, or half a breakdown, is refused', () => {
  assert.deepEqual(resolvePaymentBase({}), { ok: false, issue: 'amount_required' });
  assert.deepEqual(resolvePaymentBase({ amountMinor: null }), { ok: false, issue: 'amount_required' });
  assert.deepEqual(resolvePaymentBase({ transactionCount: 3 }), { ok: false, issue: 'incomplete_breakdown' });
  assert.deepEqual(resolvePaymentBase({ amountMinor: 900, unitPriceMinor: 300 }), { ok: false, issue: 'incomplete_breakdown' });
});

test('the count is a whole number of at least 1', () => {
  for (const transactionCount of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(resolvePaymentBase({ transactionCount, unitPriceMinor: 100 }), { ok: false, issue: 'transaction_count' }, String(transactionCount));
  }
});

test('the unit price is whole minor units of at least 0; a zero price leaves no base', () => {
  for (const unitPriceMinor of [-1, 0.5, Number.NaN]) {
    assert.deepEqual(resolvePaymentBase({ transactionCount: 2, unitPriceMinor }), { ok: false, issue: 'unit_price' }, String(unitPriceMinor));
  }
  assert.deepEqual(resolvePaymentBase({ transactionCount: 5, unitPriceMinor: 0 }), { ok: false, issue: 'amount_range' });
});

test('the product must fit the column', () => {
  assert.equal(resolvePaymentBase({ transactionCount: 1, unitPriceMinor: MAX_AMOUNT_MINOR }).ok, true);
  assert.deepEqual(resolvePaymentBase({ transactionCount: 2, unitPriceMinor: MAX_AMOUNT_MINOR }), { ok: false, issue: 'amount_range' });
  assert.deepEqual(resolvePaymentBase({ transactionCount: 100_000, unitPriceMinor: 100_000 }), { ok: false, issue: 'amount_range' });
});
