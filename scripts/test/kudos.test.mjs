// Unit tests for the kudos rule (#1868) — src/lib/kudosRule.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Pinned: a kudo goes only between the two sides of a pairing (or from an
// admin to either side), never to oneself, never to a stranger; and the preset
// list stays sentences — nothing in it is a score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { kudoSendRefusal, canReadKudos, isKudoPreset, KUDO_PRESETS } = await import('../../src/lib/kudosRule.ts');

const rel = { mentorId: 'mentor', menteeId: 'mentee' };

test('the two sides of the pair thank each other', () => {
  assert.equal(kudoSendRefusal(rel, 'mentor', 'mentee', false), null);
  assert.equal(kudoSendRefusal(rel, 'mentee', 'mentor', false), null);
});

test('nobody thanks themselves, admin included', () => {
  assert.equal(kudoSendRefusal(rel, 'mentor', 'mentor', false), 'self');
  assert.equal(kudoSendRefusal(rel, 'mentee', 'mentee', true), 'self');
});

test('a stranger is refused; an admin may thank either side', () => {
  assert.equal(kudoSendRefusal(rel, 'stranger', 'mentee', false), 'not_participant');
  assert.equal(kudoSendRefusal(rel, 'admin', 'mentee', true), null);
  assert.equal(kudoSendRefusal(rel, 'admin', 'mentor', true), null);
});

test('the recipient must be one side of the pair', () => {
  assert.equal(kudoSendRefusal(rel, 'mentor', 'someone-else', false), 'not_participant');
  assert.equal(kudoSendRefusal(rel, 'admin', 'someone-else', true), 'not_participant');
});

test('reading: the pair and admins only', () => {
  assert.equal(canReadKudos(rel, 'mentor', false), true);
  assert.equal(canReadKudos(rel, 'mentee', false), true);
  assert.equal(canReadKudos(rel, 'admin', true), true);
  assert.equal(canReadKudos(rel, 'stranger', false), false);
});

test('presets are a closed list', () => {
  for (const p of KUDO_PRESETS) assert.equal(isKudoPreset(p), true);
  assert.equal(isKudoPreset('points'), false);
  assert.equal(isKudoPreset(undefined), false);
});
