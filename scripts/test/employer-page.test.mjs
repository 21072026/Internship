// The public employer page (#1867, docs/employer-page.md).
// Run: node --test --experimental-strip-types scripts/test/employer-page.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPLOYER_SLUG_MAX,
  employerSlugBase,
  employerSlugCandidate,
  isEmployerSlug,
  isPublicEmployer,
  isSafeWebsiteUrl,
} from '../../src/lib/employerPage.ts';
import { kebabSlug } from '../../src/lib/transliterate.ts';

const slugOf = (name) => employerSlugBase(kebabSlug(name, EMPLOYER_SLUG_MAX));

test('Turkish names transliterate into sane slugs', () => {
  assert.equal(slugOf('Şişecam Çağrı Ölçüm A.Ş.'), 'sisecam-cagri-olcum-a-s');
  assert.equal(slugOf('İstanbul Yazılım GmbH & Co. KG'), 'istanbul-yazilim-gmbh-co-kg');
  assert.equal(slugOf('  ---  '), 'employer');
  const long = slugOf('a'.repeat(30) + ' ' + 'b'.repeat(40));
  assert.ok(long.length <= EMPLOYER_SLUG_MAX && !long.endsWith('-'));
  for (const s of ['sisecam-cagri-olcum-a-s', 'employer', long]) assert.ok(isEmployerSlug(s), s);
});

test('a taken base gets -2, -3 … within the cap', () => {
  assert.equal(employerSlugCandidate('acme', 1), 'acme');
  assert.equal(employerSlugCandidate('acme', 2), 'acme-2');
  const base = 'x'.repeat(EMPLOYER_SLUG_MAX);
  const tenth = employerSlugCandidate(base, 10);
  assert.ok(tenth.length <= EMPLOYER_SLUG_MAX && tenth.endsWith('-10'));
  assert.ok(isEmployerSlug(tenth));
});

test('slug shape guard refuses anything that is not a plain slug', () => {
  for (const bad of ['', 'Acme', 'acme_co', '-acme', 'acme-', 'a--b', '../etc', 'a'.repeat(61)]) assert.ok(!isEmployerSlug(bad), bad);
});

test('only an opted-in, verified company with a slug is public', () => {
  const ok = { isPublicProfile: true, verificationStatus: 'VERIFIED', slug: 'acme' };
  assert.equal(isPublicEmployer(ok), true);
  assert.equal(isPublicEmployer({ ...ok, isPublicProfile: false }), false);
  assert.equal(isPublicEmployer({ ...ok, verificationStatus: 'PENDING' }), false);
  assert.equal(isPublicEmployer({ ...ok, verificationStatus: 'SUSPENDED' }), false);
  assert.equal(isPublicEmployer({ ...ok, slug: null }), false);
});

test('a public website link is https without credentials', () => {
  assert.ok(isSafeWebsiteUrl('https://acme.example/careers'));
  for (const bad of ['http://acme.example', 'javascript:alert(1)', 'https://user:pw@acme.example', 'acme.example', '']) assert.ok(!isSafeWebsiteUrl(bad), bad);
});
