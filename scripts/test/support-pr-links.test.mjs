// Unit tests for a feedback report's PR links (#3928, src/lib/supportReportPrLinks.ts).
// What must hold: only a PR of this repository is stored, in one canonical form;
// the same PR is never stored twice; the list is bounded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrLink, addPrLink, removePrLink, readPrLinks, SUPPORT_PR_LINK_MAX, SUPPORT_PR_REPO } from '../../src/lib/supportReportPrLinks.ts';

const base = `https://github.com/${SUPPORT_PR_REPO}/pull`;
const now = new Date('2026-11-25T12:00:00Z');

test('a PR link of this repository is accepted in its canonical form', () => {
  assert.deepEqual(parsePrLink(`${base}/3934`), { ok: true, url: `${base}/3934`, number: 3934 });
  assert.deepEqual(parsePrLink(`  ${base}/3934/  `), { ok: true, url: `${base}/3934`, number: 3934 });
  assert.deepEqual(parsePrLink(`${base}/3934#discussion_r1`), { ok: true, url: `${base}/3934`, number: 3934 });
  assert.equal(parsePrLink(`https://github.com/${SUPPORT_PR_REPO.toUpperCase()}/pull/7`).ok, true);
});

test('anything else is refused, and says why', () => {
  assert.deepEqual(parsePrLink('https://github.com/someone/else/pull/1'), { ok: false, error: 'wrong_repo' });
  for (const bad of [`${base.replace('https', 'http')}/1`, `https://github.com/${SUPPORT_PR_REPO}/issues/1`, `${base}/0`, `${base}/abc`, 'javascript:alert(1)', `https://evil.example/${SUPPORT_PR_REPO}/pull/1`, 42, null]) {
    assert.equal(parsePrLink(bad).ok, false, String(bad));
  }
});

test('add is idempotent per PR, bounded, and remove takes exactly one', () => {
  let r = addPrLink(null, `${base}/1`, 'admin-1', now);
  assert.ok(r.ok && r.changed);
  const once = r.links;
  r = addPrLink(once, `${base}/1/`, 'admin-1', now);
  assert.ok(r.ok && !r.changed);
  assert.equal(r.links.length, 1);
  let many = once;
  for (let n = 2; n <= SUPPORT_PR_LINK_MAX; n += 1) {
    const step = addPrLink(many, `${base}/${n}`, 'admin-1', now);
    assert.ok(step.ok);
    many = step.links;
  }
  assert.deepEqual(addPrLink(many, `${base}/999`, 'admin-1', now), { ok: false, error: 'too_many' });
  const removed = removePrLink(many, 2);
  assert.equal(removed.changed, true);
  assert.deepEqual(removed.links.map((l) => l.number), many.map((l) => l.number).filter((n) => n !== 2));
  assert.equal(removePrLink(many, 12345).changed, false);
});

test('a stored list is read back clean; malformed entries are dropped', () => {
  const stored = [{ url: `${base}/5`, number: 5, addedAt: now.toISOString(), addedById: 'a' }, { url: 'https://evil.example/x' }, 'junk', null];
  assert.deepEqual(readPrLinks(stored).map((l) => l.number), [5]);
  assert.deepEqual(readPrLinks('not a list'), []);
});

const { parseIssueLink } = await import('../../src/lib/supportReportPrLinks.ts');

test('the review issue is an issue of this repository, stored in one form (#3937)', () => {
  const issues = `https://github.com/${SUPPORT_PR_REPO}/issues`;
  assert.deepEqual(parseIssueLink(`${issues}/3937/`), { ok: true, url: `${issues}/3937`, number: 3937 });
  assert.deepEqual(parseIssueLink('https://github.com/someone/else/issues/1'), { ok: false, error: 'wrong_repo' });
  for (const bad of [`${base}/1`, `${issues}/0`, 'https://evil.example/x/issues/1', null]) assert.equal(parseIssueLink(bad).ok, false, String(bad));
});
