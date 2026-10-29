// The quarantine deadline check (#1610): a quarantined test needs an issue and
// a live expiry no more than 30 days out.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuarantine, MAX_DAYS } from '../check-quarantine.mjs';

const TODAY = new Date('2026-10-28T15:00:00Z');
const spec = (text) => [{ path: 'e2e/x.spec.ts', text }];

test('a well-formed quarantine passes and is listed', () => {
  const { entries, errors } = checkQuarantine(
    spec(`// quarantine: #1234 until 2026-11-20 — races the session poll\ntest('flaky one', { tag: '@quarantine' }, async () => {});`),
    TODAY,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(entries, [{ file: 'e2e/x.spec.ts', line: 2, issue: 1234, until: '2026-11-20' }]);
});

test('the note may sit above a multi-line test call, and the tag may be in an array', () => {
  const text = [
    '// quarantine: #9 until 2026-10-28 — last day still counts',
    "test(",
    "  'flaky',",
    "  { tag: ['@smoke', \"@quarantine\"] },",
    '  async () => {}',
    ');',
  ].join('\n');
  assert.deepEqual(checkQuarantine(spec(text), TODAY).errors, []);
});

test('no note, or a note without an issue, fails', () => {
  const bare = checkQuarantine(spec(`test('x', { tag: '@quarantine' }, async () => {});`), TODAY).errors;
  assert.equal(bare.length, 1);
  assert.match(bare[0], /^e2e\/x\.spec\.ts:1: @quarantine without/);
  const noIssue = checkQuarantine(spec(`// quarantine: until 2026-11-01\ntest('x', { tag: '@quarantine' }, async () => {});`), TODAY).errors;
  assert.equal(noIssue.length, 1);
});

test('an expired quarantine fails, and so does one past the limit', () => {
  const expired = checkQuarantine(spec(`// quarantine: #1 until 2026-10-27 — x\ntest('x', { tag: '@quarantine' }, async () => {});`), TODAY).errors;
  assert.match(expired[0], /expired on 2026-10-27/);
  const tooLong = checkQuarantine(spec(`// quarantine: #1 until 2026-12-31 — x\ntest('x', { tag: '@quarantine' }, async () => {});`), TODAY).errors;
  assert.match(tooLong[0], new RegExp(`more than ${MAX_DAYS} days away`));
  // Exactly MAX_DAYS out is allowed.
  const edge = checkQuarantine(spec(`// quarantine: #1 until 2026-11-27 — x\ntest('x', { tag: '@quarantine' }, async () => {});`), TODAY).errors;
  assert.deepEqual(edge, []);
});

test('a note far above the tag does not count, and the word in a comment is not a tag', () => {
  const far = ['// quarantine: #1 until 2026-11-01 — x', '', '', '', '', '', "test('x', { tag: '@quarantine' }, async () => {});"].join('\n');
  assert.equal(checkQuarantine(spec(far), TODAY).errors.length, 1);
  assert.deepEqual(checkQuarantine(spec(`// a test tagged '@quarantine' is left out of the gate`), TODAY), { entries: [], errors: [] });
});
