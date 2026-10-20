// Unit tests for the partner contract versioning (docs/affiliate-module.md, decision 14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localizedText,
  nextContractVersion,
  needsContractAcceptance,
} from '../../src/lib/affiliateContractRule.ts';

test('the contract is shown in the requested locale, falling back to English', () => {
  const map = { en: 'English text', de: 'Deutscher Text' };
  assert.equal(localizedText(map, 'de'), 'Deutscher Text');
  assert.equal(localizedText(map, 'tr'), 'English text', 'no Turkish text: English is shown');
  assert.equal(localizedText(null, 'en'), '');
});

test('the version moves only when the text really changes', () => {
  const before = { en: 'A', tr: 'B' };
  assert.equal(nextContractVersion(3, before, { en: 'A', tr: 'B' }), 3, 'same wording keeps the version');
  assert.equal(nextContractVersion(3, before, { en: 'A changed', tr: 'B' }), 4);
  assert.equal(nextContractVersion(1, null, { en: 'first' }), 2, 'a first real text is a new version');
});

test('a partner must accept the current version, and an older acceptance does not count', () => {
  assert.equal(needsContractAcceptance([], 1), true);
  assert.equal(needsContractAcceptance([1], 1), false);
  assert.equal(needsContractAcceptance([1], 2), true, 'a changed contract is asked again');
  assert.equal(needsContractAcceptance([1, 2], 2), false);
});
