// Unit tests for automatic affiliate attribution (src/lib/affiliateAttributionRule.ts,
// docs/affiliate-module.md § Automatic attribution, #3354). Synthetic ids only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// affiliateAttributionRule.ts imports its sibling without an extension; see ts-extensionless-resolve.mjs.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { planAffiliateAttribution, referralCodeKey, customerRefFor, PARTNER_CODE_MAX } = await import('../../src/lib/affiliateAttributionRule.ts');

const ACTIVE = { id: 'p-active', status: 'ACTIVE' };
const NOW = new Date('2026-10-01T00:00:00Z');
const base = { referralCode: 'demo-partner', externalId: 'acct-1', partner: ACTIVE, existing: null, eventAt: NOW };

test('an active partner with no existing link gets one, keyed on the external id', () => {
  assert.deepEqual(planAffiliateAttribution(base), { kind: 'link', partnerId: 'p-active', externalRef: 'acct-1' });
});

test('no code (null, empty, blank) is nothing to do', () => {
  for (const referralCode of [null, undefined, '', '   ']) {
    assert.deepEqual(planAffiliateAttribution({ ...base, referralCode }), { kind: 'none', reason: 'no_code' });
  }
  assert.equal(referralCodeKey('  demo-partner '), 'demo-partner');
  assert.equal(referralCodeKey(42), null);
});

test('an external id that cannot be a customer reference links nothing', () => {
  assert.deepEqual(planAffiliateAttribution({ ...base, externalId: '' }), { kind: 'none', reason: 'bad_external_id' });
  assert.deepEqual(planAffiliateAttribution({ ...base, externalId: 'x'.repeat(121) }), { kind: 'none', reason: 'bad_external_id' });
  assert.equal(customerRefFor('x'.repeat(120)), 'x'.repeat(120));
});

test('an unknown code writes nothing', () => {
  assert.deepEqual(planAffiliateAttribution({ ...base, partner: null }), { kind: 'none', reason: 'no_partner' });
});

test('a suspended partner never gets a link', () => {
  assert.deepEqual(planAffiliateAttribution({ ...base, partner: { id: 'p-x', status: 'SUSPENDED' } }), { kind: 'none', reason: 'partner_inactive' });
});

test('a terminated partner links only while the event is before its notice date, like the payment writer', () => {
  const t = (noticeEffectiveAt) => ({ ...base, partner: { id: 'p-t', status: 'TERMINATED', noticeEffectiveAt } });
  const later = new Date('2026-11-01T00:00:00Z');
  const earlier = new Date('2026-09-01T00:00:00Z');
  assert.deepEqual(planAffiliateAttribution(t(later)), { kind: 'link', partnerId: 'p-t', externalRef: 'acct-1' });
  assert.deepEqual(planAffiliateAttribution(t(NOW)), { kind: 'none', reason: 'partner_inactive' }); // at the date: over
  assert.deepEqual(planAffiliateAttribution(t(earlier)), { kind: 'none', reason: 'partner_inactive' });
  assert.deepEqual(planAffiliateAttribution(t(null)), { kind: 'none', reason: 'partner_inactive' });
  // A replayed event is judged at ITS time: before the notice date it links even if "now" is past it.
  assert.equal(planAffiliateAttribution({ ...t(NOW), eventAt: earlier }).kind, 'link');
});

test('the envelope accepts a referral code as long as a partner code can be', () => {
  assert.equal(PARTNER_CODE_MAX, 100);
});

test('the same event twice is a no-op: the same partner is already linked', () => {
  assert.deepEqual(
    planAffiliateAttribution({ ...base, existing: { partnerId: 'p-active' } }),
    { kind: 'already_linked', partnerId: 'p-active' },
  );
});

test('first link wins: another active partner is reported, never re-pointed', () => {
  assert.deepEqual(
    planAffiliateAttribution({ ...base, existing: { partnerId: 'p-first' } }),
    { kind: 'kept_first', keptPartnerId: 'p-first', offeredPartnerId: 'p-active' },
  );
});

test('an existing link is silent when the offered code would not have linked anyway', () => {
  assert.equal(planAffiliateAttribution({ ...base, partner: null, existing: { partnerId: 'p-first' } }).kind, 'none');
  assert.equal(
    planAffiliateAttribution({ ...base, partner: { id: 'p-s', status: 'SUSPENDED' }, existing: { partnerId: 'p-first' } }).kind,
    'none',
  );
});
