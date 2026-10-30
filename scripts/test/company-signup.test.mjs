// Employer self-signup (#1865, docs/company-verification.md) — the pure half.
// Run: node --test --experimental-strip-types scripts/test/company-signup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ONBOARDING_ITEMS,
  SIGNUP_MIN_FILL_MS,
  checkSignupEmail,
  domainProofRecord,
  emailDomain,
  isFreeMailDomain,
  looksAutomated,
  onboardingChecklist,
  onboardingComplete,
  txtRecordsContain,
} from '../../src/lib/companySignup.ts';

test('a work address passes, a free-mail or malformed one does not', () => {
  assert.deepEqual(checkSignupEmail(' HR@Acme-Robotics.example '), { ok: true, domain: 'acme-robotics.example' });
  assert.deepEqual(checkSignupEmail('someone@gmail.com'), { ok: false, code: 'free_mail_domain' });
  assert.deepEqual(checkSignupEmail('someone@GMX.de'), { ok: false, code: 'free_mail_domain' });
  assert.deepEqual(checkSignupEmail('no-at-sign'), { ok: false, code: 'invalid_email' });
  assert.deepEqual(checkSignupEmail('x@localhost'), { ok: false, code: 'invalid_email' });
  assert.equal(emailDomain('a@b@sub.example.org'), 'sub.example.org');
  assert.ok(isFreeMailDomain('Outlook.com'));
  assert.ok(!isFreeMailDomain('acme.example'));
});

test('honeypot and a too-fast submit look automated; a person does not', () => {
  const now = 1_000_000;
  assert.equal(looksAutomated({ honeypot: 'http://spam', renderedAt: now - 60_000, now }), true);
  assert.equal(looksAutomated({ honeypot: '', renderedAt: now - (SIGNUP_MIN_FILL_MS - 1), now }), true);
  assert.equal(looksAutomated({ honeypot: '', renderedAt: now - 60_000, now }), false);
  assert.equal(looksAutomated({ now }), false);
});

test('the domain proof matches the joined TXT chunks exactly', () => {
  const expected = domainProofRecord('abc123');
  assert.equal(expected, 'interncrm-verification=abc123');
  assert.ok(txtRecordsContain([['v=spf1 -all'], ['interncrm-verification=', 'abc123']], expected));
  assert.ok(!txtRecordsContain([['interncrm-verification=abc1234']], expected));
  assert.ok(!txtRecordsContain([], expected));
});

test('the onboarding checklist is derived from facts and completes only when every item is done', () => {
  const facts = { logoUrl: 'https://acme.example/logo.png', description: 'Robots', industry: 'Robotics', size: '50', requisitionCount: 1, verificationStatus: 'VERIFIED' };
  const all = onboardingChecklist(facts);
  assert.deepEqual(Object.keys(all).sort(), [...ONBOARDING_ITEMS].sort());
  assert.equal(onboardingComplete(all), true);
  assert.equal(onboardingChecklist({ ...facts, description: '  ' }).profile, false);
  assert.equal(onboardingChecklist({ ...facts, requisitionCount: 0 }).requisition, false);
  const pending = onboardingChecklist({ ...facts, verificationStatus: 'PENDING' });
  assert.equal(pending.verified, false);
  assert.equal(onboardingComplete(pending), false);
});
