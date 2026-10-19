// Unit tests for the affiliate commission rule (docs/affiliate-module.md).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Every number here comes from the partner contract. Where the contract is
// ambiguous the test pins the reading the code takes, so a change of reading
// is a deliberate diff, not a silent one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tierCommissionMinor,
  percentCommissionMinor,
  windowEndsAt,
  decideCommission,
} from '../../src/lib/affiliateCommissionRule.ts';

const T0 = new Date('2026-01-15T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const after = (d, days) => new Date(d.getTime() + days * DAY);

function base(overrides = {}) {
  return {
    paymentMinor: 10000,
    receivedAt: T0,
    isFirstPayment: true,
    payingCustomerOrdinal: 1,
    customerFirstPaymentAt: T0,
    switchedAt: null,
    noticeEffectiveAt: null,
    ...overrides,
  };
}

test('tier bands follow the contract table, upper bound inclusive', () => {
  assert.equal(tierCommissionMinor(1), 5000, 'a cent is in the "up to 20" band');
  assert.equal(tierCommissionMinor(2000), 5000, '20.00 is still up to 20');
  assert.equal(tierCommissionMinor(2001), 10000, '20.01 is in the 21-50 band');
  assert.equal(tierCommissionMinor(5000), 10000, '50.00 is still 21-50');
  assert.equal(tierCommissionMinor(5001), 15000, '50.01 is in the 51-100 band');
  assert.equal(tierCommissionMinor(10000), 15000, '100.00 is still 51-100');
  assert.equal(tierCommissionMinor(10001), 25000, 'above 100 is the top band');
});

test('percent commission is 20 % in integer cents, rounded half up', () => {
  assert.equal(percentCommissionMinor(10000), 2000, '100.00 -> 20.00');
  assert.equal(percentCommissionMinor(1), 0, '0.01 * 20 % rounds to 0');
  assert.equal(percentCommissionMinor(2), 0, '0.02 * 20 % = 0.004 rounds to 0');
  assert.equal(percentCommissionMinor(4), 1, '0.04 * 20 % = 0.008 rounds to 0.01');
  assert.equal(percentCommissionMinor(5), 1, '0.05 * 20 % = 0.01 exactly');
});

test('window closes exactly 24 months after the first payment', () => {
  assert.equal(windowEndsAt(T0).toISOString(), '2028-01-15T10:00:00.000Z');
});

test('the first nine paying customers earn the tier commission', () => {
  for (let ordinal = 1; ordinal <= 9; ordinal += 1) {
    const decision = decideCommission(base({ payingCustomerOrdinal: ordinal, paymentMinor: 3000 }));
    assert.deepEqual(decision, { kind: 'TIER', amountMinor: 10000 }, `ordinal ${ordinal}`);
  }
});

test('the tenth paying customer switches the partner to percent from its first payment', () => {
  const decision = decideCommission(base({ payingCustomerOrdinal: 10, paymentMinor: 3000 }));
  assert.deepEqual(decision, { kind: 'PERCENT', amountMinor: 600 });
});

test('before the switch a later payment from a customer earns nothing', () => {
  const decision = decideCommission(
    base({ isFirstPayment: false, customerFirstPaymentAt: T0, receivedAt: after(T0, 30) }),
  );
  assert.deepEqual(decision, { kind: 'NONE', reason: 'BEFORE_SWITCH' });
});

test('after the switch every later payment earns 20 %, including customers 1..9', () => {
  const switchedAt = after(T0, 60);
  const decision = decideCommission(
    base({
      isFirstPayment: false,
      customerFirstPaymentAt: T0,
      receivedAt: after(T0, 90),
      switchedAt,
      paymentMinor: 5000,
    }),
  );
  assert.deepEqual(decision, { kind: 'PERCENT', amountMinor: 1000 });
});

test('a payment received before the switch instant is not retroactive', () => {
  const switchedAt = after(T0, 60);
  const decision = decideCommission(
    base({
      isFirstPayment: false,
      customerFirstPaymentAt: T0,
      receivedAt: after(switchedAt, -1),
      switchedAt,
    }),
  );
  assert.deepEqual(decision, { kind: 'NONE', reason: 'BEFORE_SWITCH' });
});

test('percent stops at the 24-month window, exclusive', () => {
  const switchedAt = after(T0, 60);
  const ends = windowEndsAt(T0);
  const inside = decideCommission(
    base({ isFirstPayment: false, customerFirstPaymentAt: T0, receivedAt: after(ends, -1), switchedAt }),
  );
  const atEnd = decideCommission(
    base({ isFirstPayment: false, customerFirstPaymentAt: T0, receivedAt: ends, switchedAt }),
  );
  assert.equal(inside.kind, 'PERCENT');
  assert.deepEqual(atEnd, { kind: 'NONE', reason: 'WINDOW_CLOSED' });
});

test('a zero or negative payment is not a payment', () => {
  assert.deepEqual(decideCommission(base({ paymentMinor: 0 })), { kind: 'NONE', reason: 'NOT_A_PAYMENT' });
  assert.deepEqual(decideCommission(base({ paymentMinor: -500 })), { kind: 'NONE', reason: 'NOT_A_PAYMENT' });
});

test('after a termination takes effect, new customers earn nothing', () => {
  const noticeEffectiveAt = after(T0, -1);
  const decision = decideCommission(base({ noticeEffectiveAt, payingCustomerOrdinal: 2 }));
  assert.deepEqual(decision, { kind: 'NONE', reason: 'NEW_CUSTOMER_AFTER_NOTICE' });
});

test('after a termination, existing customers keep earning percent until their window closes', () => {
  const switchedAt = after(T0, 60);
  const decision = decideCommission(
    base({
      isFirstPayment: false,
      customerFirstPaymentAt: T0,
      receivedAt: after(T0, 120),
      switchedAt,
      noticeEffectiveAt: after(T0, 100),
    }),
  );
  assert.equal(decision.kind, 'PERCENT');
});
