// Accept-Language negotiation (#1384) — pure rule, no Next, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAcceptLanguage } from '../../src/i18n/acceptLanguage.ts';

const LOCALES = ['en', 'tr', 'de'];
const pick = (h) => pickAcceptLanguage(h, LOCALES);

test('a regional tag reaches its language', () => {
  assert.equal(pick('tr-TR,tr;q=0.9'), 'tr');
  assert.equal(pick('de-AT'), 'de');
  assert.equal(pick('en-US,en;q=0.9'), 'en');
});

test('the highest q wins, and a tie keeps header order', () => {
  assert.equal(pick('en;q=0.8, tr;q=0.9'), 'tr');
  assert.equal(pick('fr-FR,fr;q=0.9,de;q=0.7,tr;q=0.6'), 'de');
  assert.equal(pick('de, tr'), 'de');
  assert.equal(pick('tr;q=0.5, de;q=0.5'), 'tr');
});

test('an unsupported language falls back to the caller default (null)', () => {
  assert.equal(pick('fr'), null);
  assert.equal(pick('fr-CA,fr;q=0.9,es;q=0.8'), null);
});

test('q=0 means "not this one"', () => {
  assert.equal(pick('tr;q=0, de;q=0.1'), 'de');
  assert.equal(pick('tr;q=0'), null);
});

test('missing, empty, wildcard and garbage headers choose nothing', () => {
  for (const h of [undefined, null, '', ' ', '*', ',,,', ';q=1', 'q=0.9', '💥', 'tr;q=abc', 'tr;q=2', 'tr;q=-1']) {
    assert.equal(pick(h), null, JSON.stringify(h));
  }
  // A malformed entry is dropped, the rest of the header still counts.
  assert.equal(pick('tr;q=abc, de;q=0.4'), 'de');
});

test('case does not matter, and an absurdly long header is still bounded', () => {
  assert.equal(pick('TR-tr'), 'tr');
  assert.equal(pick(`${'x-'.repeat(2000)}, tr`), null);
  assert.equal(pick(`tr, ${'fr;q=0.1,'.repeat(500)}`), 'tr');
});
