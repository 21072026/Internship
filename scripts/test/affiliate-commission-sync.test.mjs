// Unit tests for the commission reconciliation and the payment shape checks
// (src/lib/affiliateCommissionSync.ts, docs/affiliate-module.md, #3114).
//
// Run: npm run test:unit
//
// Synthetic plan only (currency XTS). The engine itself is pinned by
// affiliate-commission-rule.test.mjs; here the question is what the writer does
// with its answer: which rows move, which are frozen, what is reported as drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// affiliateCommissionSync.ts imports its sibling without an extension; see ts-extensionless-resolve.mjs.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { evaluatePartner, MAX_AMOUNT_MINOR } = await import('../../src/lib/affiliateCommissionRule.ts');
const { planCommissionChanges, checkPaymentInput, normalizeRef } = await import('../../src/lib/affiliateCommissionSync.ts');

const PLAN = {
  currency: 'XTS',
  tiers: [{ upToMinor: 1_000, commissionMinor: 300 }],
  topCommissionMinor: 900,
  percentBps: 1_000, // 10 %
  switchAtCustomer: 2,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-03-01T08:00:00Z');
const at = (d) => new Date(T0 + d * DAY);
const pay = (id, customerId, d, amountMinor) => ({ id, customerId, amountMinor, currency: 'XTS', receivedAt: at(d) });
const stored = (paymentId, kind, amountMinor, d, over = {}) => ({
  id: `c-${paymentId}`,
  paymentId,
  kind,
  amountMinor,
  currency: 'XTS',
  dueAt: at(d + 7),
  windowEndsAt: null,
  planVersion: 3,
  status: 'PENDING',
  ...over,
});
const run = (payments, rows, planVersion = 3, recordedBeforePlan) =>
  planCommissionChanges({ evaluation: evaluatePartner(PLAN, { noticeEffectiveAt: null }, payments), payments, stored: rows, planVersion, recordedBeforePlan });

test('a first payment creates one PENDING commission with the plan version', () => {
  const ch = run([pay('p1', 'a', 0, 800)], []);
  assert.equal(ch.create.length, 1);
  assert.deepEqual(
    { ...ch.create[0], accruedAt: ch.create[0].accruedAt.toISOString(), dueAt: ch.create[0].dueAt.toISOString() },
    { kind: 'TIER', amountMinor: 300, currency: 'XTS', accruedAt: at(0).toISOString(), dueAt: at(7).toISOString(), windowEndsAt: null, planVersion: 3, paymentId: 'p1', customerId: 'a' },
  );
  assert.deepEqual([ch.update, ch.remove, ch.drift], [[], [], []]);
});

test('an unchanged history changes nothing (the writer is idempotent)', () => {
  const ps = [pay('p1', 'a', 0, 800), pay('p2', 'b', 1, 800), pay('p3', 'a', 2, 800)];
  const rows = [stored('p1', 'TIER', 300, 0), stored('p2', 'PERCENT', 80, 1), stored('p3', 'PERCENT', 80, 2)];
  assert.deepEqual(run(ps, rows), { create: [], update: [], remove: [], drift: [] });
});

test('a back-dated customer moves PENDING rows of the current version', () => {
  // Stored when only `a` and `b` existed: a = tier, b = 2nd customer → percent.
  const rows = [stored('p1', 'TIER', 300, 10), stored('p2', 'PERCENT', 80, 20)];
  // `early` is entered later but paid first: it is customer 1, `a` becomes the switch (percent), b percent.
  const ps = [pay('p1', 'a', 10, 800), pay('p2', 'b', 20, 800), pay('p0', 'early', 5, 800)];
  const ch = run(ps, rows);
  assert.deepEqual(ch.create.map((c) => [c.paymentId, c.kind, c.amountMinor]), [['p0', 'TIER', 300]]);
  assert.deepEqual(ch.update.map((u) => [u.id, u.data.kind, u.data.amountMinor]), [['c-p1', 'PERCENT', 80]]);
  assert.deepEqual(ch.remove, []);
  assert.deepEqual(ch.drift, []);
});

test('a PENDING row that no longer accrues is removed', () => {
  // Stored as percent; the history now says the partner never switched (only one customer).
  const ch = run([pay('p1', 'a', 0, 800), pay('p2', 'a', 5, 800)], [stored('p1', 'TIER', 300, 0), stored('p2', 'PERCENT', 80, 5)]);
  assert.deepEqual(ch.remove, ['c-p2']);
});

test('APPROVED and PAID rows are frozen: a disagreement is drift, never a change', () => {
  const ps = [pay('p1', 'a', 0, 800), pay('p2', 'a', 5, 800)];
  const rows = [stored('p1', 'TIER', 999, 0, { status: 'PAID' }), stored('p2', 'PERCENT', 80, 5, { status: 'APPROVED' })];
  const ch = run(ps, rows);
  assert.deepEqual([ch.create, ch.update, ch.remove], [[], [], []]);
  assert.deepEqual(ch.drift.map((d) => [d.commissionId, d.status, d.expected]), [
    ['c-p1', 'PAID', { kind: 'TIER', amountMinor: 300 }],
    ['c-p2', 'APPROVED', null],
  ]);
});

test('a PENDING row of an older plan version is frozen too', () => {
  const ch = run([pay('p1', 'a', 0, 800)], [stored('p1', 'TIER', 250, 0, { planVersion: 2 })]);
  assert.deepEqual([ch.update, ch.remove], [[], []]);
  assert.deepEqual(ch.drift.map((d) => [d.commissionId, d.planVersion]), [['c-p1', 2]]);
});

test('a REJECTED row stays rejected and is not reported', () => {
  const ch = run([pay('p1', 'a', 0, 800)], [stored('p1', 'TIER', 300, 0, { status: 'REJECTED', amountMinor: 1 })]);
  assert.deepEqual(ch, { create: [], update: [], remove: [], drift: [] });
});

test('a new plan never creates commissions for payments recorded before it took effect', () => {
  // p2 earned nothing under the old plan (no row). The new plan would pay it: drift, not a create.
  const ps = [pay('p1', 'a', 0, 800), pay('p2', 'b', 1, 800), pay('p3', 'c', 2, 800)];
  const ch = run(ps, [stored('p1', 'TIER', 300, 0, { planVersion: 2 })], 3, new Set(['p1', 'p2']));
  assert.deepEqual(ch.create.map((c) => c.paymentId), ['p3']);
  assert.deepEqual(ch.drift.map((d) => [d.paymentId, d.commissionId, d.expected]), [['p2', null, { kind: 'PERCENT', amountMinor: 80 }]]);
});

test('a changed due date alone is an update', () => {
  const ch = run([pay('p1', 'a', 0, 800)], [stored('p1', 'TIER', 300, 0, { dueAt: at(1) })]);
  assert.deepEqual(ch.update.map((u) => u.id), ['c-p1']);
});

// ── shape checks ────────────────────────────────────────────────────────────

const NOW = new Date('2026-06-01T12:00:00Z');
const good = { amountMinor: 1_500, currency: 'XTS', receivedAt: new Date('2026-05-31T00:00:00Z'), externalPaymentRef: 'inv-1', customerExternalRef: 'cust-1' };

test('a well-formed payment passes', () => {
  assert.deepEqual(checkPaymentInput(good, NOW), []);
  assert.deepEqual(checkPaymentInput({ ...good, receivedAt: NOW }, NOW), []); // "now" is not the future
});

test('references are judged and stored trimmed', () => {
  assert.equal(normalizeRef('  inv-1 \t'), 'inv-1');
  assert.deepEqual(checkPaymentInput({ ...good, externalPaymentRef: `  ${'x'.repeat(120)}  ` }, NOW), []);
});

test('every malformed field is named', () => {
  assert.deepEqual(checkPaymentInput({ ...good, amountMinor: 0 }, NOW), ['amount']);
  assert.deepEqual(checkPaymentInput({ ...good, amountMinor: 19.99 }, NOW), ['amount']);
  assert.deepEqual(checkPaymentInput({ ...good, amountMinor: MAX_AMOUNT_MINOR + 1 }, NOW), ['amount']);
  assert.deepEqual(checkPaymentInput({ ...good, currency: 'eur' }, NOW), ['currency']);
  assert.deepEqual(checkPaymentInput({ ...good, receivedAt: new Date(NOW.getTime() + 1) }, NOW), ['received_at']);
  assert.deepEqual(checkPaymentInput({ ...good, receivedAt: new Date('nope') }, NOW), ['received_at']);
  assert.deepEqual(checkPaymentInput({ ...good, externalPaymentRef: '   ' }, NOW), ['payment_ref']);
  assert.deepEqual(checkPaymentInput({ ...good, customerExternalRef: 'x'.repeat(121) }, NOW), ['customer_ref']);
});
