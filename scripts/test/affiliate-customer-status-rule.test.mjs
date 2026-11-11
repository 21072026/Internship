// Unit tests for an affiliate customer's funnel status (src/lib/affiliateCustomerStatusRule.ts,
// docs/affiliate-module.md "Customer status", #3542). Synthetic dates only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// affiliateCustomerStatusRule.ts imports its sibling without an extension; see ts-extensionless-resolve.mjs.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { customerStatus, parseCustomerStatusSettings, storedCustomerStatusSettings, DEFAULT_FREE_MONTHS, DEFAULT_PASSIVE_AFTER_DAYS } = await import(
  '../../src/lib/affiliateCustomerStatusRule.ts'
);

const DAY = 24 * 60 * 60 * 1000;
const settings = { freeMonths: 2, passiveAfterDays: 45 };
const at = (iso) => new Date(iso);
const status = (over) =>
  customerStatus({ registeredAt: at('2026-01-10T12:00:00Z'), lastPaymentAt: null, endedAt: null, now: at('2026-01-20T00:00:00Z'), settings, ...over });

test('no payment inside the free period is FREE_PERIOD', () => {
  assert.equal(status({}), 'FREE_PERIOD');
});

test('the free period runs to the same instant N calendar months later', () => {
  // Last day of the free period: one millisecond before it runs out.
  assert.equal(status({ now: at('2026-03-10T11:59:59.999Z') }), 'FREE_PERIOD');
  // The moment it runs out, a customer who never paid is NEVER_PAID.
  assert.equal(status({ now: at('2026-03-10T12:00:00Z') }), 'NEVER_PAID');
  // Month-end registration clamps to the target month's last day.
  const registeredAt = at('2025-12-31T00:00:00Z');
  assert.equal(status({ registeredAt, now: at('2026-02-27T23:59:59Z') }), 'FREE_PERIOD');
  assert.equal(status({ registeredAt, now: at('2026-02-28T00:00:00Z') }), 'NEVER_PAID');
});

test('a zero-month free period is over at registration', () => {
  assert.equal(status({ now: at('2026-01-10T12:00:00Z'), settings: { ...settings, freeMonths: 0 } }), 'NEVER_PAID');
});

test('an end without any payment is NEVER_PAID, even inside the free period', () => {
  assert.equal(status({ endedAt: at('2026-01-15T00:00:00Z') }), 'NEVER_PAID');
});

test('a payment less than passiveAfterDays old is ACTIVE; exactly passiveAfterDays is PASSIVE', () => {
  const now = at('2026-06-01T00:00:00Z');
  assert.equal(status({ now, lastPaymentAt: new Date(now.getTime() - 45 * DAY + 1) }), 'ACTIVE');
  assert.equal(status({ now, lastPaymentAt: new Date(now.getTime() - 45 * DAY) }), 'PASSIVE');
  assert.equal(status({ now, lastPaymentAt: new Date(now.getTime() - 90 * DAY) }), 'PASSIVE');
  // A payment inside the free period makes the customer ACTIVE straight away.
  assert.equal(status({ lastPaymentAt: at('2026-01-12T00:00:00Z') }), 'ACTIVE');
});

test('an end after the last payment is PASSIVE, however recent the payment', () => {
  assert.equal(status({ lastPaymentAt: at('2026-01-12T00:00:00Z'), endedAt: at('2026-01-15T00:00:00Z') }), 'PASSIVE');
  // The same instant counts as ended.
  assert.equal(status({ lastPaymentAt: at('2026-01-12T00:00:00Z'), endedAt: at('2026-01-12T00:00:00Z') }), 'PASSIVE');
});

test('a payment received after the end brings the customer back', () => {
  const now = at('2026-06-01T00:00:00Z');
  assert.equal(status({ now, endedAt: at('2026-05-01T00:00:00Z'), lastPaymentAt: at('2026-05-20T00:00:00Z') }), 'ACTIVE');
  // …and it still goes passive by age.
  assert.equal(status({ now, endedAt: at('2026-01-01T00:00:00Z'), lastPaymentAt: at('2026-02-01T00:00:00Z') }), 'PASSIVE');
});

test('settings are whole numbers in range', () => {
  assert.deepEqual(parseCustomerStatusSettings({ freeMonths: 0, passiveAfterDays: 1 }), { ok: true, settings: { freeMonths: 0, passiveAfterDays: 1 } });
  assert.deepEqual(parseCustomerStatusSettings({ freeMonths: 2.5, passiveAfterDays: 0 }), {
    ok: false,
    issues: [
      { field: 'freeMonths', code: 'invalid' },
      { field: 'passiveAfterDays', code: 'range' },
    ],
  });
  assert.deepEqual(parseCustomerStatusSettings({ freeMonths: '2', passiveAfterDays: 731 }), {
    ok: false,
    issues: [
      { field: 'freeMonths', code: 'invalid' },
      { field: 'passiveAfterDays', code: 'range' },
    ],
  });
  assert.equal(parseCustomerStatusSettings(null).ok, false);
});

test('an org without a settings row reads the defaults', () => {
  assert.deepEqual(storedCustomerStatusSettings(null), { freeMonths: DEFAULT_FREE_MONTHS, passiveAfterDays: DEFAULT_PASSIVE_AFTER_DAYS });
  assert.deepEqual(storedCustomerStatusSettings({ freeMonths: 3, passiveAfterDays: 30 }), { freeMonths: 3, passiveAfterDays: 30 });
});
