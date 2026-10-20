// Unit tests for the affiliate payment plan (docs/affiliate-module.md).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The writer (src/lib/affiliatePaymentWriter.ts) is database code and is covered
// by its end-to-end spec later. Everything it decides comes from this plan,
// which is pure, so the arithmetic is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The plan imports the rule through the `@/` alias, as the app does. The shared
// resolver (ts-extensionless-resolve) must be registered before the import.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { planAffiliatePayment, AffiliatePaymentError } = await import('../../src/lib/affiliatePaymentPlan.ts');

const T0 = new Date('2026-03-01T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const after = (d, days) => new Date(d.getTime() + days * DAY);

function input(overrides = {}) {
  return {
    amountMinor: 3000,
    currency: 'EUR',
    receivedAt: T0,
    externalPaymentRef: 'INV-1',
    customer: { firstPaymentAt: null, payingCustomerOrdinal: null },
    otherPayingCustomers: 0,
    switchedAt: null,
    noticeEffectiveAt: null,
    alreadyRecorded: false,
    ...overrides,
  };
}

function refusedWith(fn, code) {
  assert.throws(fn, (err) => err instanceof AffiliatePaymentError && err.code === code);
}

test('refuses a non-positive or fractional amount', () => {
  refusedWith(() => planAffiliatePayment(input({ amountMinor: 0 })), 'INVALID_AMOUNT');
  refusedWith(() => planAffiliatePayment(input({ amountMinor: -100 })), 'INVALID_AMOUNT');
  refusedWith(() => planAffiliatePayment(input({ amountMinor: 30.5 })), 'INVALID_AMOUNT');
});

test('refuses any currency but the contract\'s euro, without converting', () => {
  refusedWith(() => planAffiliatePayment(input({ currency: 'USD' })), 'UNSUPPORTED_CURRENCY');
});

test('refuses a payment with no external reference, manual or API', () => {
  refusedWith(() => planAffiliatePayment(input({ externalPaymentRef: '' })), 'MISSING_REFERENCE');
  refusedWith(() => planAffiliatePayment(input({ externalPaymentRef: '   ' })), 'MISSING_REFERENCE');
});

test('a payment already recorded is a duplicate and writes nothing', () => {
  const plan = planAffiliatePayment(input({ alreadyRecorded: true }));
  assert.deepEqual(plan, { kind: 'DUPLICATE' });
});

test('the third paying customer gets a tier commission and its ordinal', () => {
  const plan = planAffiliatePayment(input({ otherPayingCustomers: 2, amountMinor: 3000 }));
  assert.equal(plan.kind, 'RECORD');
  assert.deepEqual(plan.customerFirstPayment, {
    firstPaymentAt: T0,
    firstPaymentMinor: 3000,
    payingCustomerOrdinal: 3,
  });
  assert.deepEqual(plan.commission, { kind: 'TIER', amountMinor: 10000, windowEndsAt: null });
  assert.equal(plan.noneReason, null);
});

test('the tenth paying customer is paid as percent from its first payment', () => {
  const plan = planAffiliatePayment(input({ otherPayingCustomers: 9, amountMinor: 3000 }));
  assert.equal(plan.customerFirstPayment.payingCustomerOrdinal, 10);
  assert.equal(plan.commission.kind, 'PERCENT');
  assert.equal(plan.commission.amountMinor, 600);
  assert.equal(plan.commission.windowEndsAt.toISOString(), '2028-03-01T10:00:00.000Z');
});

test('a later payment before the switch earns nothing but is still recorded', () => {
  const plan = planAffiliatePayment(
    input({
      customer: { firstPaymentAt: T0, payingCustomerOrdinal: 2 },
      receivedAt: after(T0, 30),
      switchedAt: null,
    }),
  );
  assert.equal(plan.customerFirstPayment, null);
  assert.equal(plan.commission, null);
  assert.equal(plan.noneReason, 'BEFORE_SWITCH');
});

test('after the switch a later payment earns 20 % with the window from the customer\'s first payment', () => {
  const plan = planAffiliatePayment(
    input({
      customer: { firstPaymentAt: T0, payingCustomerOrdinal: 2 },
      receivedAt: after(T0, 90),
      switchedAt: after(T0, 60),
      amountMinor: 5000,
    }),
  );
  assert.equal(plan.commission.kind, 'PERCENT');
  assert.equal(plan.commission.amountMinor, 1000);
  assert.equal(plan.commission.windowEndsAt.toISOString(), '2028-03-01T10:00:00.000Z');
});

test('a later payment after the 24-month window earns nothing', () => {
  const plan = planAffiliatePayment(
    input({
      customer: { firstPaymentAt: T0, payingCustomerOrdinal: 2 },
      receivedAt: new Date('2028-03-01T10:00:00Z'),
      switchedAt: after(T0, 60),
    }),
  );
  assert.equal(plan.commission, null);
  assert.equal(plan.noneReason, 'WINDOW_CLOSED');
});

test('a payment dated before the customer\'s first payment is refused', () => {
  refusedWith(
    () =>
      planAffiliatePayment(
        input({
          customer: { firstPaymentAt: T0, payingCustomerOrdinal: 1 },
          receivedAt: after(T0, -5),
          switchedAt: after(T0, -5),
        }),
      ),
    'PAYMENT_BEFORE_FIRST_PAYMENT',
  );
});

test('a new customer after a termination takes effect is recorded as paying but earns nothing', () => {
  const plan = planAffiliatePayment(
    input({ otherPayingCustomers: 1, noticeEffectiveAt: after(T0, -1) }),
  );
  assert.equal(plan.commission, null);
  assert.equal(plan.noneReason, 'NEW_CUSTOMER_AFTER_NOTICE');
  // The customer really paid, so the facts are still written; only the commission is refused.
  assert.equal(plan.customerFirstPayment.payingCustomerOrdinal, 2);
});
