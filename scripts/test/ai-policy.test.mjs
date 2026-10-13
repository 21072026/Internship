// The AI policy chain (#2032): the org kill switch, the per-task switch, the
// per-task quota and the org quota, combined in one order.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { resolvePolicyChain, isAiOn, parseQuota, normalizeQuotaOverride, MAX_AI_QUOTA } = await import('../../src/lib/ai/policyRule.ts');

test('with no rows at all everything is on and the org quota applies — an existing install sees no change', () => {
  const p = resolvePolicyChain({ aiEnabled: undefined, orgQuota: '200', task: null });
  assert.deepEqual(p, { enabled: true, taskEnabled: true, quota: 200, quotaSource: 'org' });
  assert.equal(isAiOn(undefined), true);
  assert.equal(isAiOn('true'), true);
  assert.equal(isAiOn(' FALSE '), false);
});

test('the kill switch wins over every row below it', () => {
  const p = resolvePolicyChain({ aiEnabled: 'false', orgQuota: '200', task: { enabled: true, monthlyQuota: 50 } });
  assert.equal(p.enabled, false);
  assert.equal(p.taskEnabled, false);
  // The quota still resolves (the console shows it), but nothing runs.
  assert.equal(p.quota, 50);
});

test('a task switched off alone: the org stays on, this task does not', () => {
  const p = resolvePolicyChain({ aiEnabled: 'true', orgQuota: '200', task: { enabled: false, monthlyQuota: null } });
  assert.equal(p.enabled, true);
  assert.equal(p.taskEnabled, false);
  assert.deepEqual([p.quota, p.quotaSource], [200, 'org']);
});

test('a per-task quota replaces the org quota for that task and is measured against its own counter', () => {
  assert.deepEqual(resolvePolicyChain({ aiEnabled: 'true', orgQuota: '200', task: { enabled: true, monthlyQuota: 5 } }), { enabled: true, taskEnabled: true, quota: 5, quotaSource: 'task' });
  // 0 is a real override: this task is off by budget while the org keeps its allowance.
  assert.deepEqual(resolvePolicyChain({ aiEnabled: 'true', orgQuota: '200', task: { enabled: true, monthlyQuota: 0 } }), { enabled: true, taskEnabled: true, quota: 0, quotaSource: 'task' });
  // null inherits.
  assert.equal(resolvePolicyChain({ aiEnabled: 'true', orgQuota: '7', task: { enabled: true, monthlyQuota: null } }).quotaSource, 'org');
});

test('parseQuota: whole non-negative numbers only; anything unreadable is 0, which is AI off', () => {
  assert.equal(parseQuota('200'), 200);
  assert.equal(parseQuota(12.9), 12);
  assert.equal(parseQuota('abc'), 0);
  assert.equal(parseQuota(''), 0);
  assert.equal(parseQuota(null), 0);
  assert.equal(parseQuota(-3), 0);
});

test('normalizeQuotaOverride: empty clears, a bounded whole number sets, anything else is refused', () => {
  assert.deepEqual(normalizeQuotaOverride(null), { ok: true, value: null });
  assert.deepEqual(normalizeQuotaOverride(''), { ok: true, value: null });
  assert.deepEqual(normalizeQuotaOverride('0'), { ok: true, value: 0 });
  assert.deepEqual(normalizeQuotaOverride(42), { ok: true, value: 42 });
  assert.deepEqual(normalizeQuotaOverride(' 42 '), { ok: true, value: 42 });
  assert.deepEqual(normalizeQuotaOverride(MAX_AI_QUOTA), { ok: true, value: MAX_AI_QUOTA });
  for (const bad of [-1, 1.5, '1e3', 'x', MAX_AI_QUOTA + 1, {}, true]) assert.deepEqual(normalizeQuotaOverride(bad), { ok: false }, `refuses ${String(bad)}`);
});
