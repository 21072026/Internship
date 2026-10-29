// Unit tests for the mentor-application screening rule (#1807) —
// src/lib/mentorScreeningRule.ts: reading a stored checklist, the org policy,
// and what an approval would be refused for.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const { parseChecklist, stampItem, parseRequired, serializeRequired, missingRequired, screeningProgress, SCREENING_ITEMS } = await import(
  '../../src/lib/mentorScreeningRule.ts'
);

test('a stored checklist is read defensively: unknown keys and malformed entries are dropped', () => {
  assert.deepEqual(parseChecklist(null), {});
  assert.deepEqual(parseChecklist([]), {});
  assert.deepEqual(
    parseChecklist({
      referencesChecked: { done: true, by: 'u1', at: '2026-10-28T10:00:00.000Z' },
      interviewDone: { done: 'yes', by: 'u1', at: 'x' },
      somethingElse: { done: true, by: 'u1', at: 'x' },
    }),
    { referencesChecked: { done: true, by: 'u1', at: '2026-10-28T10:00:00.000Z' } }
  );
});

test('a tick is stamped with who and when; an untick keeps the stamp of the change', () => {
  const at = new Date('2026-10-28T10:00:00Z');
  const c = stampItem({}, 'interviewDone', true, 'admin1', at);
  assert.deepEqual(c, { interviewDone: { done: true, by: 'admin1', at: '2026-10-28T10:00:00.000Z' } });
  const off = stampItem(c, 'interviewDone', false, 'admin2', new Date('2026-10-29T00:00:00Z'));
  assert.deepEqual(off.interviewDone, { done: false, by: 'admin2', at: '2026-10-29T00:00:00.000Z' });
});

test('the policy setting keeps only known items, in vocabulary order', () => {
  assert.deepEqual(parseRequired(''), []);
  assert.deepEqual(parseRequired(null), []);
  assert.deepEqual(parseRequired(' interviewDone , bogus,referencesChecked'), ['referencesChecked', 'interviewDone']);
  assert.equal(serializeRequired(['backgroundOk', 'identityVerified', 'backgroundOk']), 'identityVerified,backgroundOk');
});

test('no policy → nothing is ever missing (approval exactly as before #1807)', () => {
  assert.deepEqual(missingRequired({}, []), []);
  assert.equal(screeningProgress({}, []).ready, true);
});

test('a required item that is not done — or was unticked — is missing', () => {
  const at = new Date();
  let c = stampItem({}, 'referencesChecked', true, 'a', at);
  assert.deepEqual(missingRequired(c, ['referencesChecked', 'interviewDone']), ['interviewDone']);
  c = stampItem(c, 'interviewDone', true, 'a', at);
  assert.deepEqual(missingRequired(c, ['referencesChecked', 'interviewDone']), []);
  c = stampItem(c, 'referencesChecked', false, 'a', at);
  assert.deepEqual(missingRequired(c, ['referencesChecked', 'interviewDone']), ['referencesChecked']);
  assert.deepEqual(screeningProgress(c, ['referencesChecked']), { done: 1, total: SCREENING_ITEMS.length, ready: false });
});
