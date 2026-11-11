// Unit tests for the partner-facing plan view (src/lib/affiliatePlanTerms.ts, #3349).
//
// Run: npm run test:unit
//
// Every plan here is SYNTHETIC — currency XTS, round-but-odd numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTermsView, bpsToPercentText } from '../../src/lib/affiliatePlanTerms.ts';

const PLAN = Object.freeze({
  currency: 'XTS',
  tiers: [
    { upToMinor: 1_000, commissionMinor: 300 },
    { upToMinor: 3_000, commissionMinor: 700 },
  ],
  topCommissionMinor: 1_100,
  percentBps: 850,
  switchAtCustomer: 7,
  boundaryCustomer: 'PERCENT',
  windowMonths: 12,
  payoutDays: 30,
  afterNotice: 'RUN_OUT',
});

test('the bands, the amount above the last band and the percent phase are carried over', () => {
  const v = planTermsView(PLAN);
  assert.deepEqual(v.bands, [
    { upToMinor: 1_000, commissionMinor: 300 },
    { upToMinor: 3_000, commissionMinor: 700 },
  ]);
  assert.deepEqual(v.top, { aboveMinor: 3_000, commissionMinor: 1_100 });
  assert.deepEqual(v.percent, { bps: 850, startsAtCustomer: 7, boundaryCustomer: 'PERCENT', windowMonths: 12 });
  assert.equal(v.payoutDays, 30);
  assert.equal(v.afterNotice, 'RUN_OUT_WINDOW');
  assert.equal(v.currency, 'XTS');
});

test('a plan without bands has one commission for every first payment', () => {
  const v = planTermsView({ ...PLAN, tiers: [] });
  assert.deepEqual(v.bands, []);
  assert.deepEqual(v.top, { aboveMinor: null, commissionMinor: 1_100 });
});

test('no percent phase without a rate or without a switch-over customer', () => {
  assert.equal(planTermsView({ ...PLAN, percentBps: 0, switchAtCustomer: null }).percent, null);
  assert.equal(planTermsView({ ...PLAN, switchAtCustomer: null }).percent, null);
  assert.equal(planTermsView({ ...PLAN, windowMonths: null }).percent.windowMonths, null);
});

test('the after-termination text follows the plan shape, as the engine behaves', () => {
  // STOP_ALL: nothing accrues, whatever the rest says.
  assert.equal(planTermsView({ ...PLAN, afterNotice: 'STOP_ALL' }).afterNotice, 'STOP_ALL');
  assert.equal(planTermsView({ ...PLAN, afterNotice: 'STOP_ALL', percentBps: 0, switchAtCustomer: null }).afterNotice, 'STOP_ALL');
  // RUN_OUT with a percent phase and a window: customers earn until their own window closes.
  assert.equal(planTermsView(PLAN).afterNotice, 'RUN_OUT_WINDOW');
  // RUN_OUT with a percent phase and no window: there is no window to close.
  assert.equal(planTermsView({ ...PLAN, windowMonths: null }).afterNotice, 'RUN_OUT_OPEN');
  // RUN_OUT without a percent phase (no rate, or no switch-over customer): nothing is left to earn.
  assert.equal(planTermsView({ ...PLAN, percentBps: 0, switchAtCustomer: null }).afterNotice, 'RUN_OUT_NONE');
  assert.equal(planTermsView({ ...PLAN, switchAtCustomer: null }).afterNotice, 'RUN_OUT_NONE');
  assert.equal(planTermsView({ ...PLAN, switchAtCustomer: null, windowMonths: null }).afterNotice, 'RUN_OUT_NONE');
});

test('the view is a copy: changing it never changes the plan', () => {
  const v = planTermsView(PLAN);
  v.bands[0].commissionMinor = 1;
  assert.equal(PLAN.tiers[0].commissionMinor, 300);
});

test('basis points read as a percentage with the given decimal mark', () => {
  assert.equal(bpsToPercentText(800), '8');
  assert.equal(bpsToPercentText(1250), '12.5');
  assert.equal(bpsToPercentText(1250, ','), '12,5');
  assert.equal(bpsToPercentText(875, ','), '8,75');
  assert.equal(bpsToPercentText(805), '8.05');
  assert.equal(bpsToPercentText(5), '0.05');
  assert.equal(bpsToPercentText(10_000), '100');
});
