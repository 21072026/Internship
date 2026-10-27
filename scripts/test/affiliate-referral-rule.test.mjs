// Unit tests for the partner referral link (src/lib/affiliateReferralRule.ts,
// docs/affiliate-module.md). Hosts are example hosts only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReferralUrl, referralLink, REFERRAL_URL_MAX_CHARS } from '../../src/lib/affiliateReferralRule.ts';

test('an empty base URL is "no link", not an error', () => {
  assert.deepEqual(parseReferralUrl(null), { ok: true, url: null });
  assert.deepEqual(parseReferralUrl(undefined), { ok: true, url: null });
  assert.deepEqual(parseReferralUrl('   '), { ok: true, url: null });
});

test('a base URL is stored as the parser prints it', () => {
  assert.deepEqual(parseReferralUrl(' https://shop.example/ '), { ok: true, url: 'https://shop.example/' });
  assert.deepEqual(parseReferralUrl('https://shop.example/pricing?utm_source=partner'), { ok: true, url: 'https://shop.example/pricing?utm_source=partner' });
});

test('refused base URLs name their reason', () => {
  assert.deepEqual(parseReferralUrl(42), { ok: false, issue: 'invalid' });
  assert.deepEqual(parseReferralUrl('shop.example'), { ok: false, issue: 'invalid' });
  assert.deepEqual(parseReferralUrl('http://shop.example/'), { ok: false, issue: 'not_https' });
  assert.deepEqual(parseReferralUrl('javascript:alert(1)'), { ok: false, issue: 'not_https' });
  assert.deepEqual(parseReferralUrl('https://user:pw@shop.example/'), { ok: false, issue: 'credentials' });
  assert.deepEqual(parseReferralUrl('https://shop.example/#top'), { ok: false, issue: 'fragment' });
  assert.deepEqual(parseReferralUrl('https://shop.example/?ref=someone'), { ok: false, issue: 'has_ref' });
  assert.deepEqual(parseReferralUrl(`https://shop.example/${'a'.repeat(REFERRAL_URL_MAX_CHARS)}`), { ok: false, issue: 'too_long' });
});

test('the link sets ref to the code, keeping the base query', () => {
  assert.equal(referralLink('https://shop.example/', 'gate-1'), 'https://shop.example/?ref=gate-1');
  assert.equal(referralLink('https://shop.example/pricing?utm_source=partner', '1042'), 'https://shop.example/pricing?utm_source=partner&ref=1042');
  assert.equal(referralLink(null, 'gate-1'), null);
  assert.equal(referralLink('http://shop.example/', 'gate-1'), null);
});
