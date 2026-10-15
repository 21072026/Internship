// Unit tests for the per-organization MARKETING price list (#2927):
// src/lib/marketingPriceListRule.ts (the rule) and its plain-ESM mirror in
// prisma/set-org-pricing.mjs (the operator CLI, which runs on Node 20 and
// cannot import TypeScript).
//
// What is pinned:
//   • there is no built-in list: unset reads as "none" (the page shows its
//     neutral "pricing on request" state);
//   • a stored value that does not parse reads as no list, and says so;
//   • money is integer minor units in a two-decimal currency, plans are listed
//     once each in key order, and unknown fields are refused;
//   • the CLI's validator accepts and refuses exactly what the app's does.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  PRICE_LIST_CURRENCIES,
  PRICE_LIST_MAX_LENGTH,
  PRICE_LIST_MAX_MIN_SEATS,
  PRICE_LIST_MAX_ONBOARDING_MINOR,
  PRICE_LIST_MAX_SEAT_MINOR,
  parsePriceList,
  priceListFromSeatMinor,
  resolvePriceList,
} = await import('../../src/lib/marketingPriceListRule.ts');
const { MARKETING_PLAN_KEYS } = await import('../../src/lib/marketingPlans.ts');
const mirror = await import('../../prisma/set-org-pricing.mjs');

const plan = (key, over = {}) => ({
  key,
  annualSeatMinor: 4900,
  monthlySeatMinor: 5900,
  minSeats: 1,
  onboardingMinor: 0,
  ...over,
});
const ACME = { currency: 'CHF', plans: [plan('team'), plan('business', { annualSeatMinor: 9900, monthlySeatMinor: null, minSeats: 3, onboardingMinor: 49000 })] };

test('unset reads as no list; a stored list wins; a broken one reads as no list and says so', () => {
  for (const raw of [undefined, null, '', '   ']) assert.deepEqual(resolvePriceList(raw), { source: 'none', list: null });
  assert.deepEqual(resolvePriceList(JSON.stringify(ACME)), { source: 'org', list: ACME });
  assert.deepEqual(resolvePriceList('{"currency":"EUR"'), { source: 'invalid', list: null });
  assert.deepEqual(resolvePriceList(JSON.stringify({ ...ACME, currency: 'JPY' })), { source: 'invalid', list: null });
});

test('the plan keys are the three translated plans, in card order', () => {
  assert.deepEqual([...MARKETING_PLAN_KEYS], ['team', 'business', 'enterprise']);
});

test('the "from" price is the cheapest annual seat', () => {
  assert.equal(priceListFromSeatMinor(ACME), 4900);
  assert.equal(priceListFromSeatMinor({ currency: 'EUR', plans: [plan('business', { annualSeatMinor: 12000 })] }), 12000);
});

test('refusals name the field', () => {
  const errs = (value) => {
    const r = parsePriceList(typeof value === 'string' ? value : JSON.stringify(value));
    assert.equal(r.ok, false);
    return r.errors.join(' | ');
  };
  assert.match(errs(''), /empty/);
  assert.match(errs('nope'), /not JSON/);
  assert.match(errs(' '.repeat(10) + 'x'.repeat(PRICE_LIST_MAX_LENGTH + 1)), /longer than/);
  assert.match(errs({ ...ACME, currency: 'JPY' }), /currency/);
  assert.match(errs({ ...ACME, extra: 1 }), /extra|Unrecognized/);
  assert.match(errs({ currency: 'EUR', plans: [plan('team', { annualSeatMinor: 49.5 })] }), /plans\.0\.annualSeatMinor/);
  assert.match(errs({ currency: 'EUR', plans: [plan('business'), plan('team')] }), /plans\.1\.key: plans are listed once each/);
  assert.match(errs({ currency: 'EUR', plans: [plan('team'), plan('team')] }), /plans\.1\.key/);
  assert.match(errs({ currency: 'EUR', plans: [] }), /plans/);
});

// One corpus, both validators. Each entry is the stored TEXT, because that is
// what both sides read.
const big = PRICE_LIST_MAX_SEAT_MINOR;
const CORPUS = [
  // valid
  JSON.stringify({ currency: 'EUR', plans: [plan('team'), plan('business', { annualSeatMinor: 9900 }), plan('enterprise', { annualSeatMinor: 19900, monthlySeatMinor: null })] }),
  JSON.stringify(ACME),
  JSON.stringify({ currency: 'TRY', plans: [plan('enterprise', { monthlySeatMinor: null })] }),
  JSON.stringify({ currency: 'USD', plans: [plan('team'), plan('enterprise')] }),
  JSON.stringify({ currency: 'GBP', plans: [plan('team', { annualSeatMinor: big, monthlySeatMinor: big, minSeats: PRICE_LIST_MAX_MIN_SEATS, onboardingMinor: PRICE_LIST_MAX_ONBOARDING_MINOR })] }),
  `  ${JSON.stringify(ACME)}\n`,
  '{"currency":"EUR","plans":[{"key":"team","annualSeatMinor":1.0,"monthlySeatMinor":null,"minSeats":1,"onboardingMinor":-0}]}',
  // invalid: shape
  '',
  'null',
  '[]',
  '"EUR"',
  '42',
  '{',
  JSON.stringify({ currency: 'EUR' }),
  JSON.stringify({ plans: [plan('team')] }),
  JSON.stringify({ currency: 'EUR', plans: {} }),
  JSON.stringify({ currency: 'EUR', plans: [null] }),
  JSON.stringify({ currency: 'EUR', plans: [[]] }),
  JSON.stringify({ currency: 'EUR', plans: [] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('team'), plan('business'), plan('enterprise'), plan('enterprise')] }),
  JSON.stringify({ ...ACME, note: 'hi' }),
  '{"currency":"EUR","plans":[{"key":"team","annualSeatMinor":1,"monthlySeatMinor":null,"minSeats":1,"onboardingMinor":0}],"__proto__":{"x":1}}',
  // invalid: currency
  JSON.stringify({ ...ACME, currency: 'eur' }),
  JSON.stringify({ ...ACME, currency: 'JPY' }),
  JSON.stringify({ ...ACME, currency: null }),
  // invalid: plan fields
  JSON.stringify({ currency: 'EUR', plans: [plan('starter')] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('Team')] }),
  JSON.stringify({ currency: 'EUR', plans: [{ ...plan('team'), color: 'red' }] }),
  JSON.stringify({ currency: 'EUR', plans: [{ key: 'team', annualSeatMinor: 4900, minSeats: 1, onboardingMinor: 0 }] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('team', { annualSeatMinor: 0 })] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('team', { annualSeatMinor: big + 1 })] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('team', { annualSeatMinor: '4900' })] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('team', { annualSeatMinor: 49.9 })] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('team', { monthlySeatMinor: 0 })] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('team', { monthlySeatMinor: false })] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('team', { minSeats: 0 })] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('team', { minSeats: PRICE_LIST_MAX_MIN_SEATS + 1 })] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('team', { onboardingMinor: -100 })] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('team', { onboardingMinor: PRICE_LIST_MAX_ONBOARDING_MINOR + 1 })] }),
  '{"currency":"EUR","plans":[{"key":"team","annualSeatMinor":1e400,"monthlySeatMinor":null,"minSeats":1,"onboardingMinor":0}]}',
  // invalid: order
  JSON.stringify({ currency: 'EUR', plans: [plan('enterprise'), plan('team')] }),
  JSON.stringify({ currency: 'EUR', plans: [plan('business'), plan('business')] }),
  // invalid: length
  JSON.stringify({ ...ACME, pad: 'x'.repeat(PRICE_LIST_MAX_LENGTH) }),
];

test('the CLI validator (prisma/set-org-pricing.mjs) agrees with the app on every corpus entry', () => {
  for (const raw of CORPUS) {
    const app = parsePriceList(raw);
    const cli = mirror.parsePriceListText(raw);
    assert.equal(cli.ok, app.ok, `accept/refuse differs for ${raw.slice(0, 120)}`);
    if (app.ok) assert.deepEqual(cli.value, app.value, `value differs for ${raw.slice(0, 120)}`);
  }
  // Both sides of the corpus are exercised.
  assert.ok(CORPUS.some((raw) => parsePriceList(raw).ok));
  assert.ok(CORPUS.some((raw) => !parsePriceList(raw).ok));
});

test('the CLI mirror carries the same limits and vocabulary as the rule', () => {
  assert.deepEqual(mirror.PLAN_KEYS, [...MARKETING_PLAN_KEYS]);
  assert.deepEqual(mirror.CURRENCIES, [...PRICE_LIST_CURRENCIES]);
  assert.equal(mirror.MAX_SEAT_MINOR, PRICE_LIST_MAX_SEAT_MINOR);
  assert.equal(mirror.MAX_ONBOARDING_MINOR, PRICE_LIST_MAX_ONBOARDING_MINOR);
  assert.equal(mirror.MAX_MIN_SEATS, PRICE_LIST_MAX_MIN_SEATS);
  assert.equal(mirror.MAX_LENGTH, PRICE_LIST_MAX_LENGTH);
});

test('the CLI prints a list an operator can check by eye', () => {
  const text = mirror.describePriceList(ACME);
  assert.match(text, /team\s+annual 49\.00 CHF\/user\/month · monthly 59\.00 CHF · min 1 users · onboarding 0\.00 CHF/);
  assert.match(text, /business\s+annual 99\.00 CHF\/user\/month · monthly — · min 3 users · onboarding 490\.00 CHF/);
});
