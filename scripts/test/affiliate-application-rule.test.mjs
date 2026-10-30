// Unit tests for the public partner application (src/lib/affiliateApplicationRule.ts,
// docs/affiliate-module.md, #3361). Synthetic people and example hosts only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAffiliateApplication, APPLICATION_LIMITS, AFFILIATE_HEARD_FROM } from '../../src/lib/affiliateApplicationRule.ts';

const valid = {
  firstName: '  Ada ',
  lastName: 'Example',
  email: ' Ada.Example@Partner.EXAMPLE ',
  company: 'Acme Consulting',
  phone: '+49 30 1234567',
  heardFrom: 'recommendation',
  consent: true,
};

test('a valid application is normalised', () => {
  const r = parseAffiliateApplication(valid);
  assert.equal(r.ok, true);
  assert.deepEqual(r.application, {
    firstName: 'Ada',
    lastName: 'Example',
    email: 'ada.example@partner.example',
    company: 'Acme Consulting',
    phone: '+49 30 1234567',
    heardFrom: 'recommendation',
    heardFromOther: null,
  });
});

test('company and phone are optional; an empty string is "not given"', () => {
  const r = parseAffiliateApplication({ ...valid, company: '', phone: '   ' });
  assert.equal(r.ok, true);
  assert.equal(r.application.company, null);
  assert.equal(r.application.phone, null);
});

test('"other" needs its text; the text is dropped for every other answer', () => {
  assert.deepEqual(parseAffiliateApplication({ ...valid, heardFrom: 'other' }), { ok: false, fields: ['heardFromOther'] });
  assert.equal(parseAffiliateApplication({ ...valid, heardFrom: 'other', heardFromOther: 'A podcast' }).application.heardFromOther, 'A podcast');
  assert.equal(parseAffiliateApplication({ ...valid, heardFromOther: 'ignored' }).application.heardFromOther, null);
});

test('consent is required as a literal true', () => {
  for (const consent of [false, 'true', 1, undefined]) {
    assert.deepEqual(parseAffiliateApplication({ ...valid, consent }), { ok: false, fields: ['consent'] }, String(consent));
  }
});

test('every refused field is named', () => {
  const r = parseAffiliateApplication({
    firstName: '',
    lastName: 'x'.repeat(APPLICATION_LIMITS.name + 1),
    email: 'not an address',
    company: 42,
    phone: 'call me',
    heardFrom: 'tv',
  });
  assert.deepEqual(r, { ok: false, fields: ['firstName', 'lastName', 'email', 'company', 'phone', 'heardFrom', 'consent'] });
  assert.equal(parseAffiliateApplication(null).ok, false);
});

test('the answer list is stable (stored codes)', () => {
  assert.equal(AFFILIATE_HEARD_FROM.length, 9);
  assert.equal(AFFILIATE_HEARD_FROM.at(-1), 'other');
});
