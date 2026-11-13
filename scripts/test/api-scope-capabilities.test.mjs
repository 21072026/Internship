// The vertical filter over API key scopes (MKT-6b, src/lib/apiScopes.ts): what
// an org is offered, what a stored key still holds, and that INTERNSHIP — which
// carries every capability — is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { API_SCOPES, SCOPE_CAPABILITY, scopeAvailable, scopesForCapabilities, effectiveScopes, ignoredScopes } = await import(
  '../../src/lib/apiScopes.ts'
);
const { verticalCapabilities } = await import('../../src/lib/verticals.ts');

const internship = verticalCapabilities('INTERNSHIP');
const marketing = verticalCapabilities('MARKETING');

test('INTERNSHIP is offered and holds every scope, exactly as before', () => {
  assert.deepEqual(scopesForCapabilities(internship), [...API_SCOPES]);
  assert.deepEqual(effectiveScopes([...API_SCOPES], internship), [...API_SCOPES]);
  assert.deepEqual(ignoredScopes([...API_SCOPES], internship), []);
});

test('MARKETING is never offered the internship hiring scope, and keeps the rest', () => {
  const offered = scopesForCapabilities(marketing);
  assert.ok(!offered.includes('hiring:read'));
  assert.ok(!scopeAvailable('hiring:read', marketing));
  for (const s of ['candidates:read', 'relationships:read', 'interactions:read', 'meetings:read', 'companies:read', 'companies:write', 'hooks:write']) {
    assert.ok(offered.includes(s), s);
  }
});

test('a stored internship-only scope is ignored in MARKETING, not deleted', () => {
  const stored = ['candidates:read', 'hiring:read', 'not-a-scope'];
  assert.deepEqual(effectiveScopes(stored, marketing), ['candidates:read', 'not-a-scope']);
  assert.deepEqual(ignoredScopes(stored, marketing), ['hiring:read']);
  // the input is untouched: the row keeps what it was minted with
  assert.deepEqual(stored, ['candidates:read', 'hiring:read', 'not-a-scope']);
});

test('an unknown string is never "available"', () => {
  assert.equal(scopeAvailable('hiring:write', internship), false);
});

test('every scope maps to a capability some vertical has', () => {
  for (const s of API_SCOPES) assert.ok(internship.includes(SCOPE_CAPABILITY[s]), s);
});

test('webhook events: MARKETING cannot subscribe to internship hiring events, INTERNSHIP to all', async () => {
  const { WEBHOOK_EVENTS } = await import('../../src/lib/events/catalog.ts');
  const { webhookEventAvailable, webhookEventsForCapabilities, ignoredWebhookEvents } = await import('../../src/lib/webhookEventCapability.ts');
  assert.deepEqual(webhookEventsForCapabilities(WEBHOOK_EVENTS, internship), [...WEBHOOK_EVENTS]);
  const offered = webhookEventsForCapabilities(WEBHOOK_EVENTS, marketing);
  for (const e of offered) assert.ok(!/^(offer|requisition|interview_request|interview_panel)\./.test(e), e);
  // the sales flow runs on the same rows: these stay
  for (const e of ['pipeline.stage_change', 'mentorship.transferred', 'interaction.logged', 'meeting.scheduled', 'user.created']) {
    assert.ok(offered.includes(e), e);
  }
  assert.equal(webhookEventAvailable('offer.sent', marketing), false);
  assert.equal(webhookEventAvailable('no.such_event', internship), false);
  assert.deepEqual(ignoredWebhookEvents(['offer.sent', 'pipeline.stage_change'], marketing), ['offer.sent']);
});
