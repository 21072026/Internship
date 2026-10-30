// Per-organization impersonation policy (#1586) — the pure rule. No Next, no DB.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { effectivePolicy, isImpersonationPolicy, readOnlyImpersonationBlocks } = await import('../../src/lib/impersonationPolicyRule.ts');

test('the default is full — an org that never chose keeps today\'s behaviour', () => {
  assert.equal(effectivePolicy(undefined), 'full');
  assert.equal(effectivePolicy(null), 'full');
  assert.equal(effectivePolicy('nonsense'), 'full');
  assert.equal(effectivePolicy('off'), 'off');
  assert.equal(isImpersonationPolicy('read_only'), true);
  assert.equal(isImpersonationPolicy('READ_ONLY'), false);
});

test('read-only refuses every API write — including routes with no hand-written block', () => {
  for (const [m, p] of [['POST', '/api/messages'], ['PATCH', '/api/profile'], ['PUT', '/api/account'], ['DELETE', '/api/goals/x'], ['post', '/api/apply'], ['POST', '/api/rsvp']]) {
    assert.equal(readOnlyImpersonationBlocks(m, p), true, `${m} ${p}`);
  }
});

test('reads and the ways out stay open', () => {
  assert.equal(readOnlyImpersonationBlocks('GET', '/api/messages'), false);
  assert.equal(readOnlyImpersonationBlocks('HEAD', '/api/profile'), false);
  assert.equal(readOnlyImpersonationBlocks('POST', '/api/impersonate/stop'), false);
  assert.equal(readOnlyImpersonationBlocks('POST', '/api/auth/callback/impersonate'), false);
  assert.equal(readOnlyImpersonationBlocks('POST', '/api/auth/signout'), false);
  assert.equal(readOnlyImpersonationBlocks('POST', '/api/csp-report'), false);
  assert.equal(readOnlyImpersonationBlocks('POST', '/api/impersonate/stopper'), true, 'exact path, not a prefix');
});
