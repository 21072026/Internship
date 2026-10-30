// Unit tests for the public partner-programme page's content
// (src/lib/affiliateLandingRule.ts, docs/affiliate-module.md, #3359).
// Synthetic copy and example hosts only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLanding,
  readStoredLanding,
  canonicalLanding,
  landingCopyFor,
  landingHasContent,
  parsePhone,
  telHref,
  parseEmail,
  EMPTY_LANDING,
  LANDING_LIMITS,
} from '../../src/lib/affiliateLandingRule.ts';

const fields = (r) => (r.ok ? [] : r.issues.map((i) => `${i.field}:${i.code}`));

test('an empty object is a valid, empty landing', () => {
  assert.deepEqual(parseLanding({}), { ok: true, landing: EMPTY_LANDING });
  assert.equal(landingHasContent(EMPTY_LANDING), false);
});

test('copy is trimmed, single-line fields collapse whitespace, paragraphs keep line breaks', () => {
  const r = parseLanding({
    copy: { de: { heroTitle: '  Partner   werden ', intro: 'Zeile eins\r\nZeile zwei  ', applyLabel: '' } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.landing.copy.de, { heroTitle: 'Partner werden', intro: 'Zeile eins\nZeile zwei' });
  assert.equal(landingHasContent(r.landing), true);
});

test('steps and bullets drop empty rows and keep half-filled ones', () => {
  const r = parseLanding({
    copy: {
      en: {
        steps: [{ title: 'Sign up', text: 'In seconds.' }, { title: '', text: '' }, { title: 'Share' }],
        bullets: ['No auto-renewal', '  ', 'Cancel any time'],
      },
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.landing.copy.en.steps, [
    { title: 'Sign up', text: 'In seconds.' },
    { title: 'Share', text: '' },
  ]);
  assert.deepEqual(r.landing.copy.en.bullets, ['No auto-renewal', 'Cancel any time']);
});

test('every problem is named by its path', () => {
  const r = parseLanding({
    copy: {
      fr: { heroTitle: 'x' },
      de: {
        heroTitle: 'x'.repeat(LANDING_LIMITS.text + 1),
        intro: 42,
        nope: 'x',
        steps: Array.from({ length: LANDING_LIMITS.steps + 1 }, () => ({ title: 'a', text: 'b' })),
        bullets: 'not a list',
      },
    },
    phone: 'call me',
    email: 'not-an-address',
    productSignupUrl: 'http://app.example/signup',
    extra: true,
  });
  assert.deepEqual(fields(r).sort(), [
    'copy.de.bullets:type',
    'copy.de.heroTitle:too_long',
    'copy.de.intro:type',
    'copy.de.nope:unknown',
    'copy.de.steps:too_many',
    'copy.fr:locale',
    'email:invalid',
    'extra:unknown',
    'phone:invalid',
    'productSignupUrl:not_https',
  ]);
});

test('non-objects are refused as a whole', () => {
  for (const v of [null, 'x', [], 1]) assert.deepEqual(fields(parseLanding(v)), ['*:type']);
});

test('phone numbers: what a person types, and the tel: link', () => {
  assert.equal(parsePhone(' +49 (0) 30  123-456 '), '+49 (0) 30 123-456');
  assert.equal(parsePhone('030/123.45'), '030/123.45');
  assert.equal(parsePhone('1234'), null); // too few digits
  assert.equal(parsePhone('12+345678'), null); // + only at the start
  assert.equal(parsePhone('0800 CALL NOW'), null);
  assert.equal(telHref('+49 (0) 30 123-456'), 'tel:+49030123456');
  assert.equal(telHref('030/123.45'), 'tel:03012345');
});

test('e-mail addresses: simple shape only', () => {
  assert.equal(parseEmail(' hello@partner.example '), 'hello@partner.example');
  assert.equal(parseEmail('a@b'), null);
  assert.equal(parseEmail('two words@partner.example'), null);
  assert.equal(parseEmail('<x>@partner.example'), null);
});

test('the sign-up URL is https without credentials, stored as printed', () => {
  const ok = parseLanding({ productSignupUrl: ' https://app.example/register ' });
  assert.equal(ok.landing.productSignupUrl, 'https://app.example/register');
  assert.deepEqual(fields(parseLanding({ productSignupUrl: 'https://u:p@app.example/' })), ['productSignupUrl:invalid']);
  assert.deepEqual(fields(parseLanding({ productSignupUrl: 'javascript:alert(1)' })), ['productSignupUrl:not_https']);
  assert.deepEqual(fields(parseLanding({ productSignupUrl: 'nope' })), ['productSignupUrl:invalid']);
});

test('a malformed stored value reads as empty, never throws', () => {
  assert.deepEqual(readStoredLanding(null), EMPTY_LANDING);
  assert.deepEqual(readStoredLanding({ copy: 'x' }), EMPTY_LANDING);
  assert.deepEqual(readStoredLanding({ copy: { en: { heroTitle: 'Hi' } } }).copy.en, { heroTitle: 'Hi' });
});

test('the canonical form ignores key order', () => {
  const a = parseLanding({ copy: { de: { intro: 'b', heroTitle: 'a' }, en: { heroTitle: 'c' } }, email: 'x@y.example' }).landing;
  const b = parseLanding({ email: 'x@y.example', copy: { en: { heroTitle: 'c' }, de: { heroTitle: 'a', intro: 'b' } } }).landing;
  assert.equal(canonicalLanding(a), canonicalLanding(b));
  const c = parseLanding({ copy: { de: { heroTitle: 'a', intro: 'B' }, en: { heroTitle: 'c' } }, email: 'x@y.example' }).landing;
  assert.notEqual(canonicalLanding(a), canonicalLanding(c));
});

test('a visitor reads their locale field by field, then English, then the rest', () => {
  const landing = parseLanding({
    copy: {
      en: { heroTitle: 'Become a partner', intro: 'English intro', steps: [{ title: 'One', text: '' }] },
      de: { heroTitle: 'Partner werden', bullets: ['Jederzeit kündbar'] },
      tr: { ctaTitle: 'Hemen başla' },
    },
  }).landing;
  const de = landingCopyFor(landing, 'de');
  assert.equal(de.heroTitle, 'Partner werden');
  assert.equal(de.intro, 'English intro');
  assert.equal(de.ctaTitle, 'Hemen başla');
  assert.deepEqual(de.steps, [{ title: 'One', text: '' }]);
  assert.deepEqual(de.bullets, ['Jederzeit kündbar']);
  assert.equal(landingCopyFor(landing, 'xx').heroTitle, 'Become a partner');
  assert.deepEqual(landingCopyFor(EMPTY_LANDING, 'de'), {});
});

test('the public table follows the plan: sorted bands, then the open top band', async () => {
  const { commissionTableRows, maxOneOffCommission } = await import('../../src/lib/affiliateLandingRule.ts');
  const plan = {
    currency: 'EUR',
    tiers: [
      { upToMinor: 5_000, commissionMinor: 1_000 },
      { upToMinor: 2_000, commissionMinor: 500 },
    ],
    topCommissionMinor: 1_500,
    percentBps: 0,
    switchAtCustomer: null,
    windowMonths: null,
  };
  assert.deepEqual(commissionTableRows(plan), [
    { overMinor: null, upToMinor: 2_000, commissionMinor: 500 },
    { overMinor: 2_000, upToMinor: 5_000, commissionMinor: 1_000 },
    { overMinor: 5_000, upToMinor: null, commissionMinor: 1_500 },
  ]);
  assert.equal(maxOneOffCommission(plan), 1_500);
  assert.deepEqual(commissionTableRows({ ...plan, tiers: [] }), [{ overMinor: null, upToMinor: null, commissionMinor: 1_500 }]);
});
