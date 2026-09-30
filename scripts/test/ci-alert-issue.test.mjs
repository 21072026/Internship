// Unit tests for the SMTP-free failure channel of the scheduled nets (#2322).
// Run: node --test scripts/test/ci-alert-issue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIssue,
  isValidKey,
  normaliseSignature,
  parseState,
  pickIssue,
  shouldComment,
} from '../ci-alert-issue.mjs';

const base = { key: 'e2e-full', title: 'E2E red', summary: 'shard 1', sig: 'abc123', reds: 1, runUrl: 'https://x/runs/1' };

test('the stamped state round-trips through the body', () => {
  const { body } = buildIssue({ ...base, reds: 3 });
  assert.deepEqual(parseState(body), { key: 'e2e-full', sig: 'abc123', reds: 3 });
  assert.equal(parseState('no marker here'), null);
  assert.equal(parseState(undefined), null);
});

test('one issue per net: picked by the key in the marker, never the title', () => {
  const e2e = { number: 7, body: buildIssue(base).body };
  const k6 = { number: 8, body: buildIssue({ ...base, key: 'k6-load' }).body };
  const human = { number: 9, body: 'e2e-full is red (a human-written issue)' };
  assert.equal(pickIssue([human, k6, e2e], 'e2e-full').number, 7);
  assert.equal(pickIssue([human, k6, e2e], 'k6-load').number, 8);
  assert.equal(pickIssue([human], 'e2e-full'), null);
  assert.equal(pickIssue(undefined, 'e2e-full'), null);
});

test('comment only when the signature moved — same broken commit pings once', () => {
  const previous = parseState(buildIssue(base).body);
  assert.equal(shouldComment(previous, 'abc123'), false);
  assert.equal(shouldComment(previous, 'def456'), true);
  // A brand-new issue is itself the notification.
  assert.equal(shouldComment(null, 'abc123'), false);
});

test('the maintainer is named only when the issue is opened', () => {
  assert.match(buildIssue({ ...base, isNew: true }).body, /cc @mersahin/);
  assert.doesNotMatch(buildIssue({ ...base, isNew: false }).body, /@mersahin/);
});

test('signatures stay marker-safe, and default to the UTC day', () => {
  assert.equal(normaliseSignature(' a b\tc '), 'a_b_c');
  assert.equal(normaliseSignature('x--y---z'), 'x-y-z');
  assert.equal(normaliseSignature('', new Date('2026-09-30T23:59:00Z')), '2026-09-30');
  assert.equal(normaliseSignature(undefined, new Date('2026-10-01T00:00:00Z')), '2026-10-01');
  const { body } = buildIssue({ ...base, sig: normaliseSignature('has space') });
  assert.equal(parseState(body).sig, 'has_space');
});

test('keys are a closed alphabet', () => {
  for (const ok of ['e2e-full', 'k6-load', 'stress', 'backup-verify']) assert.equal(isValidKey(ok), true);
  for (const bad of ['', 'E2E', 'a b', 'x'.repeat(41), undefined, 'a;rm']) assert.equal(isValidKey(bad), false);
});

test('a missing summary still yields a readable body and a default title', () => {
  const { title, body } = buildIssue({ ...base, title: '', summary: '' });
  assert.equal(title, '🚨 e2e-full is red');
  assert.match(body, /open the run for details/);
  assert.match(body, /closes itself on the next green run/);
});
