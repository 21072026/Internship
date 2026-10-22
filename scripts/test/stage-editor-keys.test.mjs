// Unit tests for the stage editor's two pure rules (#1635): the key a new
// stage gets from the label an admin typed, and which removed stages still
// carry records (the PUT's 409 and the editor's disabled remove control).
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { stageKeyFromLabel, removedStagesInUse } = await import('../../src/lib/pipeline.ts');

const NONE = new Set();

test('a label becomes an uppercase [A-Z0-9_] key', () => {
  assert.equal(stageKeyFromLabel('Ready to place', NONE), 'READY_TO_PLACE');
  assert.equal(stageKeyFromLabel('New stage', NONE), 'NEW_STAGE');
  assert.equal(stageKeyFromLabel('  --a  b-- ', NONE), 'A_B');
});

test('diacritics fold to their base letter (TR/DE labels)', () => {
  assert.equal(stageKeyFromLabel('Café Über', NONE), 'CAFE_UBER');
  assert.equal(stageKeyFromLabel('İş görüşmesi', NONE), 'IS_GORUSMESI');
});

test('a label with no usable character still yields a key', () => {
  assert.equal(stageKeyFromLabel('', NONE), 'STAGE');
  assert.equal(stageKeyFromLabel('!!!', NONE), 'STAGE');
});

test('a key never starts with a digit', () => {
  assert.equal(stageKeyFromLabel('2nd interview', NONE), 'S_2ND_INTERVIEW');
});

test('a taken key gets the next free numeric suffix', () => {
  assert.equal(stageKeyFromLabel('Ready to place', new Set(['READY_TO_PLACE'])), 'READY_TO_PLACE_2');
  assert.equal(
    stageKeyFromLabel('Ready to place', new Set(['READY_TO_PLACE', 'READY_TO_PLACE_2'])),
    'READY_TO_PLACE_3',
  );
});

test('a key stays within 50 characters, suffix included', () => {
  const long = 'x'.repeat(80);
  const first = stageKeyFromLabel(long, NONE);
  assert.equal(first, 'X'.repeat(50));
  const second = stageKeyFromLabel(long, new Set([first]));
  assert.equal(second.length, 50);
  assert.ok(second.endsWith('_2'));
  assert.notEqual(second, first);
});

test('only a dropped stage that still has records is reported, with its count', () => {
  assert.deepEqual(removedStagesInUse(['A', 'B', 'C', 'D'], ['A', 'C'], { A: 3, B: 2 }), { B: 2 });
});

test('dropping unused stages, or keeping used ones, reports nothing', () => {
  assert.deepEqual(removedStagesInUse(['A', 'B'], ['A'], { A: 5 }), {});
  assert.deepEqual(removedStagesInUse(['A', 'B'], ['A', 'B'], { A: 1, B: 1 }), {});
  assert.deepEqual(removedStagesInUse(['A', 'B'], ['A'], { B: 0 }), {});
});
