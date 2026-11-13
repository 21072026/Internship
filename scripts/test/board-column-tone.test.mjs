// Unit tests for the board's column tone (#3666, #3675; src/lib/boardColumnTone.ts).
//
// Run: node --test --experimental-strip-types scripts/test/board-column-tone.test.mjs
//
// What a reviewer cannot keep in their head: the tone is keyed by the stage's
// position among ALL stages (so hiding a column never repaints another), the
// last stage is always slate, two neighbours never share a tone, and no tone
// uses a utility globals.css repaints (blue = the org accent, gray = dark mode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardColumnTone } from '../../src/lib/boardColumnTone.ts';

const keys = (n) => Array.from({ length: n }, (_, i) => `S${i}`);

test('the first stage is sky, the last is always slate', () => {
  const k = keys(7);
  assert.match(boardColumnTone('S0', k), /^bg-sky-100 /);
  assert.match(boardColumnTone('S6', k), /^bg-slate-200 /);
  assert.match(boardColumnTone('S1', keys(2)), /^bg-slate-200 /);
});

test('a single stage is not "the last" — it takes the first tone', () => {
  assert.match(boardColumnTone('S0', ['S0']), /^bg-sky-100 /);
});

test('neighbours never share a tone, for any pipeline length up to 25', () => {
  for (let n = 2; n <= 25; n++) {
    const k = keys(n);
    for (let i = 1; i < n; i++) {
      assert.notEqual(boardColumnTone(k[i], k), boardColumnTone(k[i - 1], k), `n=${n} i=${i}`);
    }
  }
});

test('the tone is keyed by position among ALL stages, so a filtered view keeps it', () => {
  const all = keys(8);
  const visible = ['S0', 'S3', 'S7'];
  assert.match(boardColumnTone('S3', all), /^bg-yellow-100 /); // fourth stage of eight
  // Asking with the visible list instead would repaint S3 — the reason the
  // callers pass every stage key.
  assert.notEqual(boardColumnTone('S3', all), boardColumnTone('S3', visible));
});

test('the cycle wraps after ten tones (the last stage aside)', () => {
  const k = keys(12);
  assert.equal(boardColumnTone('S10', k), boardColumnTone('S0', k));
});

test('an unknown key gets the neutral fallback, not a cycle tone', () => {
  assert.equal(boardColumnTone('NOPE', keys(3)), 'bg-gray-50 border-gray-200');
});

test('no stage tone uses a utility globals.css repaints (bg-blue-* = accent, bg-gray-* = dark remap)', () => {
  const k = keys(11);
  for (const key of k) {
    const tone = boardColumnTone(key, k);
    assert.doesNotMatch(tone, /\bbg-blue-|\bborder-blue-/, key);
    assert.doesNotMatch(tone, /\bbg-gray-|\bborder-gray-/, key);
    assert.match(tone, /\bdark:bg-/, `${key} has its own dark tone`);
  }
});

test('the drop-target ring follows the org accent', () => {
  const css = readFileSync(new URL('../../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /html\[data-accent\] \.ring-blue-500 \{ --tw-ring-color: var\(--accent-500\); \}/);
});
