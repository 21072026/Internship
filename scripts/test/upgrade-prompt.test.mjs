// Unit tests for the paywall reader (#1745).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// What the prompt names as "the plan that lifts it" has to agree with the
// pricing page, and the parser must read the CODE — never the English text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { parseGateBody, liftFor } = await import('../../src/lib/upgradePrompt.ts');
const { annualMonthlyEur, planLimits } = await import('../../src/lib/plans.ts');

test('only the two gate codes parse; the English error is never read', () => {
  assert.equal(parseGateBody({ error: 'Plan limit reached: 25/25' }), null);
  assert.equal(parseGateBody({ code: 'already_mentored' }), null);
  assert.equal(parseGateBody(null), null);
  const g = parseGateBody({ code: 'plan_limit_reached', limit: 25, usage: 25, plan: 'FREE', error: 'x' });
  assert.deepEqual(g, { code: 'plan_limit_reached', limit: 25, usage: 25, plan: 'FREE', adminsNotified: false });
  assert.equal(parseGateBody({ code: 'feature_locked', feature: 'NOPE' }).feature, undefined);
});

test('a FREE tenant at its cap is lifted by Program, at its published monthly price', () => {
  const lift = liftFor({ code: 'plan_limit_reached', limit: 25, usage: 25, plan: 'FREE' });
  assert.equal(lift.kind, 'plan');
  assert.equal(lift.planKey, 'program');
  assert.equal(lift.monthlyEur, annualMonthlyEur('program'));
  assert.equal(lift.requestable, true);
});

test('the next plan up must have a band larger than the cap that was hit', () => {
  // A PRO tenant capped at 200: Program's band (100) does not lift it.
  const lift = liftFor({ code: 'plan_limit_reached', limit: 200, usage: 200, plan: 'PRO' });
  assert.equal(lift.planKey, 'program_plus');
  assert.ok(planLimits('program_plus').activePairs > 200);
});

test('a locked feature names the cheapest plan of the right wallet', () => {
  assert.equal(liftFor({ code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }).planKey, 'program');
  assert.equal(liftFor({ code: 'feature_locked', feature: 'SSO_SAML' }).planKey, 'program_plus');
  const employer = liftFor({ code: 'feature_locked', feature: 'TALENT_POOL_SEARCH' }, 'EMPLOYER');
  assert.equal(employer.planKey, 'employer');
  // A company cannot be sold a plan through the programme's request form.
  assert.equal(employer.requestable, false);
});

test('the AI pack is an add-on, and an unknown feature is a conversation', () => {
  const ai = liftFor({ code: 'feature_locked', feature: 'AI_PACKAGE' });
  assert.equal(ai.kind, 'addon');
  assert.equal(ai.monthlyEur, 49);
  assert.equal(liftFor({ code: 'feature_locked' }).kind, 'contact');
});
