// Unit tests for the plan-change request rules (#1743).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Which plan a tenant may ask for, on which interval, and what an applied
// change writes to the legacy Organization.plan column. The last one is the
// quiet failure: Program Plus written as PRO would sell white-label and SSO
// that the legacy plan gate then refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { planChangeRefusal, legacyPlanFor, REQUESTABLE_PLAN_KEYS, isOpenRequest, statusAfter } = await import(
  '../../src/lib/planChangeRule.ts'
);
const { LEGACY_PLAN_MAP, plansForAudience } = await import('../../src/lib/plans.ts');
const { orgPlanHasFeature } = await import('../../src/lib/orgPlans.ts');

const base = { currentPlan: 'community', currentInterval: 'MONTHLY' };

test('only programme-side plans are requestable', () => {
  assert.deepEqual([...REQUESTABLE_PLAN_KEYS], plansForAudience('PROGRAM').map((p) => p.key));
  assert.equal(planChangeRefusal({ ...base, requestedPlan: 'employer', billingCycle: 'YEARLY' }), 'unknown_plan');
  assert.equal(planChangeRefusal({ ...base, requestedPlan: 'team', billingCycle: 'YEARLY' }), 'unknown_plan');
  assert.equal(planChangeRefusal({ ...base, requestedPlan: 42, billingCycle: 'YEARLY' }), 'unknown_plan');
});

test('an upgrade on a sold interval is allowed', () => {
  assert.equal(planChangeRefusal({ ...base, requestedPlan: 'program', billingCycle: 'MONTHLY' }), null);
  assert.equal(planChangeRefusal({ ...base, requestedPlan: 'program_plus', billingCycle: 'YEARLY' }), null);
});

test('the same plan on the same interval is nothing to change; the other interval is', () => {
  const cur = { currentPlan: 'program', currentInterval: 'MONTHLY' };
  assert.equal(planChangeRefusal({ ...cur, requestedPlan: 'program', billingCycle: 'MONTHLY' }), 'same_plan');
  assert.equal(planChangeRefusal({ ...cur, requestedPlan: 'program', billingCycle: 'YEARLY' }), null);
});

test('Enterprise is annual-only; an unknown interval is refused', () => {
  assert.equal(planChangeRefusal({ ...base, requestedPlan: 'enterprise', billingCycle: 'MONTHLY' }), 'interval_not_sold');
  assert.equal(planChangeRefusal({ ...base, requestedPlan: 'enterprise', billingCycle: 'YEARLY' }), null);
  assert.equal(planChangeRefusal({ ...base, requestedPlan: 'program', billingCycle: 'ANNUAL' }), 'interval_not_sold');
});

test('the legacy plan an applied change writes keeps the old gate in step', () => {
  assert.equal(legacyPlanFor('community'), 'FREE');
  assert.equal(legacyPlanFor('program'), 'PRO');
  assert.equal(legacyPlanFor('program_plus'), 'ENTERPRISE');
  assert.equal(legacyPlanFor('enterprise'), 'ENTERPRISE');
  assert.equal(legacyPlanFor('nonsense'), 'FREE');
  // Round trip through the forward map for the plans it names.
  for (const [legacy, key] of Object.entries(LEGACY_PLAN_MAP)) assert.equal(legacyPlanFor(key), legacy);
  // Program Plus sells white-label and SSO; the legacy gate must agree.
  assert.ok(orgPlanHasFeature(legacyPlanFor('program_plus'), 'WHITE_LABEL'));
  assert.ok(orgPlanHasFeature(legacyPlanFor('program_plus'), 'SSO_SAML'));
});

test('only NEW is open; an action leaves it APPLIED or REJECTED', () => {
  assert.equal(isOpenRequest('NEW'), true);
  assert.equal(isOpenRequest('APPLIED'), false);
  assert.equal(statusAfter('apply'), 'APPLIED');
  assert.equal(statusAfter('reject'), 'REJECTED');
});
