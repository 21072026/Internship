// Unit tests for src/lib/upgradePrompt.ts — the one reader of a plan or
// entitlement 403 (#1745).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { parseGateBody, parseGateError, upgradeOffer, currentPlanKey, planDisplayName } = await import('../../src/lib/upgradePrompt.ts');

test('the code decides, never the error text', () => {
  assert.deepEqual(parseGateBody({ error: 'Plan limit reached …', code: 'plan_limit_reached', limit: 25, usage: 25, plan: 'FREE' }), {
    code: 'plan_limit_reached', plan: 'FREE', limit: 25, usage: 25,
  });
  assert.deepEqual(parseGateBody({ error: 'feature_locked', code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }), {
    code: 'feature_locked', feature: 'ADVANCED_ANALYTICS',
  });
  // The old talent-pool body carried the code only in `error`: not a gate.
  assert.equal(parseGateBody({ error: 'feature_locked' }), null);
  assert.equal(parseGateBody({ code: 'feature_locked', feature: 'NOT_A_FEATURE' }), null);
  assert.equal(parseGateBody({ code: 'already_mentored' }), null);
  assert.equal(parseGateBody(null), null);
  assert.equal(parseGateBody('plan_limit_reached'), null);
});

test('parseGateError reads only a 403, from a clone', async () => {
  const body = JSON.stringify({ code: 'plan_limit_reached', limit: 25, usage: 25, plan: 'FREE' });
  const res = new Response(body, { status: 403 });
  assert.equal((await parseGateError(res))?.code, 'plan_limit_reached');
  assert.equal((await res.json()).limit, 25, 'the caller can still read the body');
  assert.equal(await parseGateError(new Response(body, { status: 409 })), null);
  assert.equal(await parseGateError(new Response('not json', { status: 403 })), null);
});

test('the relation cap offers the next plan with more active pairs, with its published price', () => {
  const free = upgradeOffer({ code: 'plan_limit_reached', plan: 'FREE', limit: 25, usage: 25 });
  assert.equal(free.planKey, 'program');
  assert.equal(free.planName, 'Program');
  assert.equal(free.yearly, 1788);
  assert.equal(free.monthly, 189);
  assert.equal(upgradeOffer({ code: 'plan_limit_reached', plan: 'PRO', limit: 100, usage: 100 }).planKey, 'program_plus');
  assert.equal(upgradeOffer({ code: 'plan_limit_reached', plan: 'program_plus', limit: 400, usage: 400 }).planKey, 'enterprise');
});

test('a locked feature offers the cheapest plan of its wallet that includes it', () => {
  assert.equal(upgradeOffer({ code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }).planKey, 'program');
  assert.equal(upgradeOffer({ code: 'feature_locked', feature: 'INTEGRATIONS_API' }).planKey, 'program_plus');
  assert.equal(upgradeOffer({ code: 'feature_locked', feature: 'TALENT_POOL_SEARCH' }, 'EMPLOYER').planKey, 'employer');
  // An add-on no plan sells: no offer, the prompt shows the pricing link alone.
  assert.equal(upgradeOffer({ code: 'feature_locked', feature: 'AI_PACKAGE' }), null);
});

test('plan names: legacy values map to the catalogue name', () => {
  assert.equal(currentPlanKey('FREE'), 'community');
  assert.equal(currentPlanKey('program'), 'program');
  assert.equal(currentPlanKey(null), null);
  assert.equal(planDisplayName('FREE'), 'Community');
  assert.equal(planDisplayName('UNKNOWN'), 'UNKNOWN');
});
