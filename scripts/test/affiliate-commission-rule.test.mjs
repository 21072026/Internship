// Unit tests for the affiliate commission engine (src/lib/affiliateCommissionRule.ts,
// docs/affiliate-module.md).
//
// Run: npm run test:unit
//
// Every plan here is SYNTHETIC — currency XTS (ISO 4217's code reserved for
// testing), round-but-odd numbers that resemble no real contract. A real
// organisation's rates are data and never appear in this repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommissionPlan,
  tierCommissionMinor,
  percentCommissionMinor,
  addMonthsUtc,
  evaluatePartner,
} from '../../src/lib/affiliateCommissionRule.ts';

const PLAN = Object.freeze({
  currency: 'XTS',
  tiers: [
    { upToMinor: 1_000, commissionMinor: 300 },
    { upToMinor: 3_000, commissionMinor: 700 },
  ],
  topCommissionMinor: 1_100,
  percentBps: 1_500, // 15 %
  switchAtCustomer: 3,
  boundaryCustomer: 'PERCENT',
  windowMonths: 6,
  payoutDays: 10,
  afterNotice: 'RUN_OUT',
});
const plan = (over = {}) => ({ ...PLAN, ...over });

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-10T09:00:00Z');
const at = (days) => new Date(T0 + days * DAY);
let seq = 0;
const pay = (customerId, days, amountMinor, extra = {}) => ({
  id: `p${String(++seq).padStart(4, '0')}`,
  customerId,
  amountMinor,
  currency: 'XTS',
  receivedAt: at(days),
  ...extra,
});
const ACTIVE = { noticeEffectiveAt: null };
const outcomes = (ev) => ev.payments.map((e) => (e.outcome.kind === 'NONE' ? `NONE:${e.outcome.reason}` : `${e.outcome.kind}:${e.outcome.amountMinor}`));

// ── plan validation ─────────────────────────────────────────────────────────

test('a complete plan parses', () => {
  const r = parseCommissionPlan(PLAN);
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan, PLAN);
});

test('every problem is reported at once', () => {
  const r = parseCommissionPlan({ currency: 'eur', tiers: [{ upToMinor: 5, commissionMinor: -1 }, { upToMinor: 5, commissionMinor: 1 }], percentBps: 10_001, boundaryCustomer: 'X', payoutDays: 1.5 });
  assert.equal(r.ok, false);
  const got = r.issues.map((i) => `${i.field}:${i.code}`).sort();
  assert.deepEqual(got, [
    'afterNotice:required',
    'boundaryCustomer:type',
    'currency:type',
    'payoutDays:type',
    'percentBps:range',
    'tiers.0.commissionMinor:range',
    'tiers.1.upToMinor:order',
    'topCommissionMinor:required',
  ]);
});

test('a switch into a 0 % phase is refused', () => {
  const r = parseCommissionPlan(plan({ percentBps: 0 }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues, [{ field: 'percentBps', code: 'combination' }]);
  assert.equal(parseCommissionPlan(plan({ percentBps: 0, switchAtCustomer: null })).ok, true);
});

test('garbage is refused, not thrown', () => {
  for (const v of [null, undefined, 42, 'plan', []]) assert.equal(parseCommissionPlan(v).ok, false);
});

// ── arithmetic ──────────────────────────────────────────────────────────────

test('tier bands are inclusive and leave no gap', () => {
  const p = plan();
  assert.equal(tierCommissionMinor(p, 1), 300);
  assert.equal(tierCommissionMinor(p, 1_000), 300);
  assert.equal(tierCommissionMinor(p, 1_001), 700); // one minor unit above a bound is the next band
  assert.equal(tierCommissionMinor(p, 3_000), 700);
  assert.equal(tierCommissionMinor(p, 3_001), 1_100);
  assert.equal(tierCommissionMinor(plan({ tiers: [] }), 1), 1_100);
});

test('percent rounds half up in integers', () => {
  const p = plan();
  assert.equal(percentCommissionMinor(p, 1_000), 150);
  assert.equal(percentCommissionMinor(p, 10), 2); // 1.5 → 2
  assert.equal(percentCommissionMinor(p, 9), 1); // 1.35 → 1
  assert.equal(percentCommissionMinor(plan({ percentBps: 3_333 }), 3), 1); // 0.9999 → 1
});

test('month arithmetic clamps to the last day of the month', () => {
  assert.equal(addMonthsUtc(new Date('2026-01-31T12:00:00Z'), 1).toISOString(), '2026-02-28T12:00:00.000Z');
  assert.equal(addMonthsUtc(new Date('2028-01-31T12:00:00Z'), 1).toISOString(), '2028-02-29T12:00:00.000Z');
  assert.equal(addMonthsUtc(new Date('2026-08-31T00:00:00Z'), 6).toISOString(), '2027-02-28T00:00:00.000Z');
  assert.equal(addMonthsUtc(new Date('2026-11-15T00:00:00Z'), 14).toISOString(), '2028-01-15T00:00:00.000Z');
});

// ── the partner timeline ────────────────────────────────────────────────────

test('before the switch: one tier per customer, later payments earn nothing', () => {
  const ev = evaluatePartner(plan(), ACTIVE, [pay('a', 0, 800), pay('a', 30, 800), pay('b', 40, 2_500)]);
  assert.deepEqual(outcomes(ev), ['TIER:300', 'NONE:BEFORE_SWITCH', 'TIER:700']);
  assert.equal(ev.switchedAt, null);
  assert.deepEqual(ev.customerOrder, ['a', 'b']);
});

test('the boundary customer switches the partner; percent is not retroactive', () => {
  const ps = [
    pay('a', 0, 800), // 1st customer: tier
    pay('a', 20, 800), // before the switch: nothing
    pay('b', 25, 5_000), // 2nd customer: tier (top)
    pay('c', 50, 2_000), // 3rd customer = switch, boundary PERCENT
    pay('a', 50, 800), // same instant as the switch: inclusive → percent
    pay('b', 60, 5_000), // after the switch: percent
    pay('d', 70, 2_000), // 4th customer: percent on its first payment
  ];
  const ev = evaluatePartner(plan(), ACTIVE, ps);
  assert.deepEqual(outcomes(ev), ['TIER:300', 'NONE:BEFORE_SWITCH', 'TIER:1100', 'PERCENT:300', 'PERCENT:120', 'PERCENT:750', 'PERCENT:300']);
  assert.equal(ev.switchedAt.toISOString(), at(50).toISOString());
});

test('boundary TIER: the switching customer still gets its tier', () => {
  const ev = evaluatePartner(plan({ boundaryCustomer: 'TIER' }), ACTIVE, [pay('a', 0, 800), pay('b', 1, 800), pay('c', 2, 800), pay('a', 3, 800)]);
  assert.deepEqual(outcomes(ev), ['TIER:300', 'TIER:300', 'TIER:300', 'PERCENT:120']);
});

test('no switch configured: tiers only, forever', () => {
  const ev = evaluatePartner(plan({ switchAtCustomer: null }), ACTIVE, [pay('a', 0, 800), pay('b', 1, 800), pay('c', 2, 800), pay('d', 3, 800), pay('a', 9, 800)]);
  assert.deepEqual(outcomes(ev), ['TIER:300', 'TIER:300', 'TIER:300', 'TIER:300', 'NONE:BEFORE_SWITCH']);
});

test('percent from the very first customer', () => {
  const ev = evaluatePartner(plan({ switchAtCustomer: 1, tiers: [], topCommissionMinor: 0 }), ACTIVE, [pay('a', 0, 1_000), pay('a', 30, 1_000)]);
  assert.deepEqual(outcomes(ev), ['PERCENT:150', 'PERCENT:150']);
});

test('the window closes per customer, measured from its first payment', () => {
  const p = plan({ switchAtCustomer: 1 });
  const first = pay('a', 0, 1_000);
  const ev = evaluatePartner(p, ACTIVE, [first, pay('a', 150, 1_000), { ...pay('a', 0, 1_000), receivedAt: addMonthsUtc(first.receivedAt, 6) }]);
  assert.deepEqual(outcomes(ev), ['PERCENT:150', 'PERCENT:150', 'NONE:WINDOW_CLOSED']);
  assert.equal(ev.payments[0].windowEndsAt.toISOString(), addMonthsUtc(first.receivedAt, 6).toISOString());
  assert.equal(evaluatePartner(plan({ switchAtCustomer: 1, windowMonths: null }), ACTIVE, [pay('z', 0, 100), pay('z', 3_000, 100)]).payments[1].outcome.kind, 'PERCENT');
});

test('ordinals follow first-payment DATE, not entry order (a back-dated entry)', () => {
  // Entered in this order; `late` is back-dated to before `x`.
  const x = pay('x', 10, 800);
  const y = pay('y', 20, 800);
  const late = pay('late', 5, 800);
  const ev = evaluatePartner(plan({ switchAtCustomer: 3 }), ACTIVE, [x, y, late, pay('x', 30, 800)]);
  assert.deepEqual(ev.customerOrder, ['late', 'x', 'y']);
  assert.deepEqual(ev.payments.map((e) => e.customerOrdinal), [2, 3, 1, 2]);
  // y is now the 3rd customer: it switches the partner at day 20, so x's day-30 payment earns percent.
  assert.deepEqual(outcomes(ev), ['TIER:300', 'PERCENT:120', 'TIER:300', 'PERCENT:120']);
});

test('the same history in any input order gives the same answer', () => {
  const ps = [pay('a', 0, 800), pay('b', 1, 2_000), pay('c', 2, 4_000), pay('a', 3, 800), pay('c', 3, 4_000)];
  const fwd = evaluatePartner(plan(), ACTIVE, ps);
  const rev = evaluatePartner(plan(), ACTIVE, [...ps].reverse());
  const key = (ev) => Object.fromEntries(ev.payments.map((e) => [e.paymentId, e.outcome]));
  assert.deepEqual(key(rev), key(fwd));
});

test('payments that are not payments never make a paying customer', () => {
  const ps = [pay('a', 0, 0), pay('a', 1, -500), pay('a', 2, 12.5), pay('b', 3, 800, { currency: 'XXX' }), pay('a', 4, 800)];
  const ev = evaluatePartner(plan(), ACTIVE, ps);
  assert.deepEqual(outcomes(ev), ['NONE:NOT_A_PAYMENT', 'NONE:NOT_A_PAYMENT', 'NONE:NOT_A_PAYMENT', 'NONE:CURRENCY_MISMATCH', 'TIER:300']);
  assert.deepEqual(ev.customerOrder, ['a']); // the zero payment on day 0 did not make `a` a customer on day 0
});

// ── termination ─────────────────────────────────────────────────────────────

test('a customer first paying after the termination earns nothing and never switches the partner', () => {
  const notice = { noticeEffectiveAt: at(30) };
  const ps = [pay('a', 0, 800), pay('b', 10, 800), pay('c', 30, 800), pay('a', 40, 800)];
  const ev = evaluatePartner(plan(), notice, ps);
  assert.deepEqual(outcomes(ev), ['TIER:300', 'TIER:300', 'NONE:NEW_CUSTOMER_AFTER_NOTICE', 'NONE:BEFORE_SWITCH']);
  assert.equal(ev.switchedAt, null); // c would have been the 3rd customer
  assert.equal(ev.payments[2].customerOrdinal, null);
});

test('RUN_OUT: existing customers keep earning inside their window after the termination', () => {
  const ps = [pay('a', 0, 800), pay('b', 1, 800), pay('c', 2, 800), pay('a', 40, 800), pay('a', 400, 800)];
  const ev = evaluatePartner(plan({ afterNotice: 'RUN_OUT' }), { noticeEffectiveAt: at(30) }, ps);
  assert.deepEqual(outcomes(ev), ['TIER:300', 'TIER:300', 'PERCENT:120', 'PERCENT:120', 'NONE:WINDOW_CLOSED']);
});

test('STOP_ALL: nothing accrues at or after the termination', () => {
  const ps = [pay('a', 0, 800), pay('b', 1, 800), pay('c', 2, 800), pay('a', 30, 800), pay('b', 40, 800)];
  const ev = evaluatePartner(plan({ afterNotice: 'STOP_ALL' }), { noticeEffectiveAt: at(30) }, ps);
  assert.deepEqual(outcomes(ev), ['TIER:300', 'TIER:300', 'PERCENT:120', 'NONE:AFTER_NOTICE', 'NONE:AFTER_NOTICE']);
});

test('due date is receivedAt + payoutDays, and only when something accrues', () => {
  const ev = evaluatePartner(plan(), ACTIVE, [pay('a', 0, 800), pay('a', 5, 800)]);
  assert.equal(ev.payments[0].dueAt.toISOString(), at(10).toISOString());
  assert.equal(ev.payments[1].dueAt, null);
});
