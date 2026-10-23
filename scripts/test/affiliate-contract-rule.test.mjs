// Unit tests for the partner contract rule and the affiliate row scope
// (src/lib/affiliateContractRule.ts, docs/affiliate-module.md, #3115).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseContractTexts,
  readStoredContract,
  contractChanged,
  contractTextFor,
  contractStateFor,
  affiliateRowScope,
  CONTRACT_MAX_CHARS,
} from '../../src/lib/affiliateContractRule.ts';

test('a contract is one text per supported locale; blanks mean "no text"', () => {
  assert.deepEqual(parseContractTexts({ en: 'Terms', tr: '   ', de: null }), { ok: true, texts: { en: 'Terms' } });
  assert.deepEqual(parseContractTexts({}), { ok: true, texts: {} });
});

test('every problem is reported at once', () => {
  const r = parseContractTexts({ fr: 'x', en: 5, de: 'x'.repeat(CONTRACT_MAX_CHARS + 1) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues.map((i) => `${i.locale}:${i.code}`).sort(), ['de:too_long', 'en:type', 'fr:locale']);
  for (const bad of [null, 'text', [], 3]) assert.equal(parseContractTexts(bad).ok, false);
});

test('line endings are normalised, so a pasted CRLF text is the same text', () => {
  assert.deepEqual(parseContractTexts({ en: 'a\r\nb\rc' }).texts, { en: 'a\nb\nc' });
  assert.equal(contractChanged({ en: 'a\nb' }, parseContractTexts({ en: 'a\r\nb' }).texts), false);
});

test('key order never makes a contract "changed" (a JSON column sorts its keys)', () => {
  const stored = JSON.parse('{"de":"Bedingungen","en":"Terms","tr":"Koşullar"}');
  assert.equal(contractChanged(stored, { en: 'Terms', tr: 'Koşullar', de: 'Bedingungen' }), false);
});

test('any text difference, an added or a removed locale is a change', () => {
  const stored = { en: 'Terms', tr: 'Koşullar' };
  assert.equal(contractChanged(stored, { en: 'Terms.', tr: 'Koşullar' }), true);
  assert.equal(contractChanged(stored, { en: 'Terms', tr: 'Koşullar', de: 'Bedingungen' }), true);
  assert.equal(contractChanged(stored, { en: 'Terms' }), true);
  assert.equal(contractChanged(null, {}), false);
  assert.equal(contractChanged(null, { en: 'Terms' }), true);
});

test('a malformed stored value reads as "no contract"', () => {
  assert.deepEqual(readStoredContract('garbage'), {});
  assert.deepEqual(readStoredContract({ en: 42 }), {});
  assert.deepEqual(readStoredContract(undefined), {});
});

test("a partner reads their language, else English, else the first text there is", () => {
  const texts = { en: 'Terms', de: 'Bedingungen' };
  assert.deepEqual(contractTextFor(texts, 'de'), { locale: 'de', text: 'Bedingungen' });
  assert.deepEqual(contractTextFor(texts, 'tr'), { locale: 'en', text: 'Terms' });
  assert.deepEqual(contractTextFor({ tr: 'Koşullar' }, 'de'), { locale: 'tr', text: 'Koşullar' });
  assert.equal(contractTextFor({}, 'en'), null);
});

test('a partner must accept the CURRENT version; no contract asks nothing', () => {
  assert.deepEqual(contractStateFor(0, []), { currentVersion: 0, acceptedVersion: 0, mustAccept: false });
  assert.deepEqual(contractStateFor(2, [1]), { currentVersion: 2, acceptedVersion: 1, mustAccept: true });
  assert.deepEqual(contractStateFor(2, [1, 2]), { currentVersion: 2, acceptedVersion: 2, mustAccept: false });
});

test('row scope: the admin sees the programme, a partner only itself, anyone else nothing', () => {
  assert.deepEqual(affiliateRowScope({ role: 'ADMIN', orgId: 'o1' }), { orgId: 'o1' });
  assert.deepEqual(affiliateRowScope({ role: 'AFFILIATE', orgId: 'o1', partnerId: 'p1' }), { orgId: 'o1', partnerId: 'p1' });
  assert.equal(affiliateRowScope({ role: 'AFFILIATE', orgId: 'o1' }), null); // no partner record: nothing
  for (const role of ['MENTOR', 'MENTEE', 'COMPANY', 'SOURCE']) assert.equal(affiliateRowScope({ role, orgId: 'o1' }), null);
  assert.equal(affiliateRowScope({ role: 'ADMIN', orgId: null }), null);
});
