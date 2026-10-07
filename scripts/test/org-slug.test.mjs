// Organization slug rule (#2065) — shared by the wizard and the create route. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { ORG_SLUG_MAX, slugifyOrg } = await import('../../src/lib/orgSlug.ts');

test('lowercase, alphanumerics and single hyphens', () => {
  assert.equal(slugifyOrg('Acme Talent GmbH'), 'acme-talent-gmbh');
  assert.equal(slugifyOrg('  --Hello__World!!  '), 'hello-world');
  assert.equal(slugifyOrg('a  &  b'), 'a-b');
});

test('nothing usable → empty (the route answers slug_invalid)', () => {
  assert.equal(slugifyOrg(''), '');
  assert.equal(slugifyOrg('!!!'), '');
});

test('Turkish and accented letters are transliterated, not dropped', () => {
  assert.equal(slugifyOrg('Çalışkan Ünlü'), 'caliskan-unlu');
  assert.equal(slugifyOrg('Café İstanbul Ölçü'), 'cafe-istanbul-olcu');
});

test('capped at the column length, never ending in a hyphen', () => {
  const long = slugifyOrg(`${'a'.repeat(59)} b`);
  assert.ok(long.length <= ORG_SLUG_MAX);
  assert.ok(!long.endsWith('-'), long);
  assert.equal(slugifyOrg('x'.repeat(80)).length, ORG_SLUG_MAX);
});
