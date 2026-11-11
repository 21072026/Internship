// Session length on interaction logs (#3521) — the pure half. No Next, no DB.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const {
  DURATION_MIN, DURATION_MAX, CHAT_DURATION_PRESETS,
  isValidDuration, parseDurationInput, formatDuration, totalDuration,
  encodeDurationChoice, decodeDurationChoice,
} = await import('../../src/lib/interactionDuration.ts');

const units = { minutes: '{n} min', hours: '{n} h' };

test('the bound is a whole number of minutes, 1…600, and every chat preset is inside it', () => {
  assert.equal(DURATION_MIN, 1);
  assert.equal(DURATION_MAX, 600);
  for (const v of [1, 45, 600]) assert.equal(isValidDuration(v), true, String(v));
  for (const v of [0, -5, 601, 12.5, NaN, '45', null, undefined]) assert.equal(isValidDuration(v), false, String(v));
  for (const p of CHAT_DURATION_PRESETS) assert.equal(isValidDuration(p), true, String(p));
});

test('form text: empty clears, a valid whole number parses, anything else is invalid', () => {
  assert.equal(parseDurationInput(''), null);
  assert.equal(parseDurationInput('   '), null);
  assert.equal(parseDurationInput('45'), 45);
  assert.equal(parseDurationInput(' 90 '), 90);
  for (const raw of ['0', '601', '12.5', '-3', '1e2', 'abc']) assert.equal(parseDurationInput(raw), undefined, raw);
});

test('formatting: minutes, whole hours, and hours with minutes', () => {
  assert.equal(formatDuration(45, units), '45 min');
  assert.equal(formatDuration(60, units), '1 h');
  assert.equal(formatDuration(75, units), '1 h 15 min');
  assert.equal(formatDuration(600, units), '10 h');
});

test('the total adds recorded lengths only — a log without one adds nothing, never a guess', () => {
  assert.equal(totalDuration([{ durationMinutes: 30 }, { durationMinutes: null }, {}, { durationMinutes: 45 }]), 75);
  assert.equal(totalDuration([]), 0);
});

test('the chat button value round-trips strictly; a forged or out-of-range value is refused', () => {
  const v = encodeDurationChoice('cmabc123', 45);
  assert.equal(v, '45:cmabc123');
  assert.deepEqual(decodeDurationChoice(v), { minutes: 45, interactionId: 'cmabc123' });
  for (const bad of [null, '', '45', ':cmabc', '0:cmabc', '999:cmabc', '45:bad id', '45:a.b', '4x:cm']) {
    assert.equal(decodeDurationChoice(bad), null, String(bad));
  }
});
