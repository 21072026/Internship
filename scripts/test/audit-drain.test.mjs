// Unit tests for src/lib/auditDrainRule.ts — the audit stream's rules (#2012):
// encoding, signing, the cursor, the backoff/pause state machine and the URL
// shape check. The Prisma/HTTP half (src/lib/auditDrain.ts) is covered by
// e2e/audit-stream.spec.ts against a local sink.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const rule = await import('../../src/lib/auditDrainRule.ts');

const row = (id, createdAt, extra = {}) => ({
  id,
  orgId: 'org-a',
  actorId: 'admin-1',
  action: 'IMPERSONATE_START',
  targetId: 'user-9',
  detail: null,
  createdAt: new Date(createdAt),
  ...extra,
});

test('json_lines carries every column, detail parsed when it is JSON, newline-terminated', () => {
  const rows = [row('a1', '2026-10-07T05:00:00.000Z', { detail: '{"moved":{"relations":3}}' }), row('a2', '2026-10-07T05:00:01.000Z', { detail: 'plain words' })];
  const body = rule.encodeBatch(rows, 'json_lines');
  assert.ok(body.endsWith('\n'));
  const lines = body.trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    id: 'a1', orgId: 'org-a', action: 'IMPERSONATE_START', actorId: 'admin-1', targetId: 'user-9',
    detail: { moved: { relations: 3 } }, createdAt: '2026-10-07T05:00:00.000Z',
  });
  assert.equal(lines[1].detail, 'plain words');
  assert.equal(rule.encodeBatch([], 'json_lines'), '');
});

test('a detail that only looks like JSON stays a string; blank is null', () => {
  assert.equal(rule.detailValue('{not json'), '{not json');
  assert.equal(rule.detailValue('   '), null);
  assert.equal(rule.detailValue(null), null);
  assert.deepEqual(rule.detailValue(' [1,2] '), [1, 2]);
});

test('ecs maps timestamp, event, actor, related users and tenant, and keeps the original record', () => {
  const r = row('a1', '2026-10-07T05:00:00.000Z');
  const ecs = rule.encodeRecord(r, 'ecs');
  assert.equal(ecs['@timestamp'], '2026-10-07T05:00:00.000Z');
  assert.deepEqual(ecs.event, { id: 'a1', action: 'IMPERSONATE_START', kind: 'event', dataset: 'interncrm.audit', created: '2026-10-07T05:00:00.000Z' });
  assert.deepEqual(ecs.user, { id: 'admin-1' });
  assert.deepEqual(ecs.related, { user: ['admin-1', 'user-9'] });
  assert.deepEqual(ecs.organization, { id: 'org-a' });
  assert.equal(ecs.interncrm.audit.id, 'a1');
  // No target → no duplicate in related, no user_target.
  const solo = rule.encodeRecord(row('a2', '2026-10-07T05:00:00.000Z', { targetId: null }), 'ecs');
  assert.deepEqual(solo.related, { user: ['admin-1'] });
  assert.equal('user_target' in solo, false);
});

test('the signature is sha256= over the exact body bytes, with the shared secret', () => {
  const body = rule.encodeBatch([row('a1', '2026-10-07T05:00:00.000Z')], 'json_lines');
  const expected = `sha256=${createHmac('sha256', 'topsecret').update(body, 'utf8').digest('hex')}`;
  assert.equal(rule.signBatch('topsecret', body), expected);
  assert.notEqual(rule.signBatch('othersecret', body), expected);
  const headers = rule.batchHeaders({ signature: expected, batchId: 'b-1', count: 1, format: 'json_lines' });
  assert.equal(headers['Content-Type'], 'application/x-ndjson');
  assert.equal(headers['X-Signature'], expected);
  assert.equal(headers['X-Audit-Count'], '1');
  assert.equal(headers['X-Audit-Format'], 'json_lines');
  assert.equal('X-Audit-Test' in headers, false);
  assert.equal(rule.batchHeaders({ signature: expected, batchId: 'b-1', count: 2, format: 'ecs', test: true })['X-Audit-Test'], '1');
});

test('the cursor is the last shipped row, and the order is (createdAt, id)', () => {
  const same = new Date('2026-10-07T05:00:00.000Z');
  const rows = [row('a1', same), row('a2', same), row('b1', '2026-10-07T05:00:01.000Z')];
  assert.deepEqual(rule.cursorAfter(rows), { cursorAt: new Date('2026-10-07T05:00:01.000Z'), cursorId: 'b1' });
  assert.equal(rule.cursorAfter([]), null);
  const cursor = { cursorAt: same, cursorId: 'a1' };
  assert.equal(rule.isAfterCursor(row('a1', same), cursor), false, 'the cursor row itself is shipped');
  assert.equal(rule.isAfterCursor(row('a2', same), cursor), true, 'same instant, later id');
  assert.equal(rule.isAfterCursor(row('a0', same), cursor), false, 'same instant, earlier id');
  assert.equal(rule.isAfterCursor(row('zz', '2026-10-07T04:59:59.000Z'), cursor), false);
  assert.equal(rule.isAfterCursor(row('a0', '2026-10-07T05:00:01.000Z'), cursor), true);
  assert.equal(rule.isAfterCursor(row('x', same), null), true, 'no cursor: everything is new');
});

test('a success moves the cursor and clears the failures; an empty success moves nothing', () => {
  const now = new Date('2026-10-07T06:00:00.000Z');
  const rows = [row('a1', '2026-10-07T05:00:00.000Z'), row('a2', '2026-10-07T05:00:05.000Z')];
  const patch = rule.afterAttempt({ active: true, failures: 3, nextAttemptAt: now }, { ok: true, rows }, now);
  assert.deepEqual(patch, {
    cursorAt: new Date('2026-10-07T05:00:05.000Z'), cursorId: 'a2',
    lastOkAt: now, lastError: null, failures: 0, nextAttemptAt: null,
  });
  const empty = rule.afterAttempt({ active: true, failures: 0, nextAttemptAt: null }, { ok: true, rows: [] }, now);
  assert.equal('cursorAt' in empty, false);
  assert.equal(empty.failures, 0);
});

test('a failure keeps the cursor, counts, and backs off 1m → 5m → 15m → 1h → 6h (capped)', () => {
  const now = new Date('2026-10-07T06:00:00.000Z');
  const steps = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 6 * 60 * 60_000];
  steps.forEach((ms, i) => {
    const patch = rule.afterAttempt({ active: true, failures: i, nextAttemptAt: null }, { ok: false, error: 'HTTP 503' }, now);
    assert.equal('cursorAt' in patch, false, 'a failure never moves the cursor');
    assert.equal(patch.failures, i + 1);
    assert.equal(patch.lastError, 'HTTP 503');
    assert.equal(patch.nextAttemptAt.getTime(), now.getTime() + ms, `failure #${i + 1}`);
    assert.equal('active' in patch, false);
  });
  assert.equal(rule.backoffMs(0), 60_000, 'a zero or negative count still waits the minimum');
});

test('past the ceiling a failing drain pauses itself with the reason, instead of retrying forever', () => {
  const now = new Date('2026-10-07T06:00:00.000Z');
  const patch = rule.afterAttempt(
    { active: true, failures: rule.AUDIT_DRAIN_PAUSE_AFTER_FAILURES - 1, nextAttemptAt: null },
    { ok: false, error: 'ECONNREFUSED' },
    now,
  );
  assert.equal(patch.active, false);
  assert.equal(patch.nextAttemptAt, null);
  assert.equal(patch.failures, rule.AUDIT_DRAIN_PAUSE_AFTER_FAILURES);
  assert.match(patch.lastError, /ECONNREFUSED — paused after 20 consecutive failures/);
});

test('isDue: active and not held back', () => {
  const now = new Date('2026-10-07T06:00:00.000Z');
  assert.equal(rule.isDue({ active: true, failures: 0, nextAttemptAt: null }, now), true);
  assert.equal(rule.isDue({ active: true, failures: 1, nextAttemptAt: new Date(now.getTime() + 1) }, now), false);
  assert.equal(rule.isDue({ active: true, failures: 1, nextAttemptAt: now }, now), true);
  assert.equal(rule.isDue({ active: false, failures: 0, nextAttemptAt: null }, now), false);
});

test('the URL shape: https only (http only under the e2e switch), no credentials, within the cap', () => {
  assert.deepEqual(rule.checkDrainUrlShape(' https://hec.example.com:8088/services/collector '), { ok: true, url: 'https://hec.example.com:8088/services/collector' });
  assert.deepEqual(rule.checkDrainUrlShape('http://127.0.0.1:4601/ingest'), { ok: false, reason: 'not_https' });
  assert.deepEqual(rule.checkDrainUrlShape('http://127.0.0.1:4601/ingest', { allowInsecure: true }), { ok: true, url: 'http://127.0.0.1:4601/ingest' });
  assert.deepEqual(rule.checkDrainUrlShape('https://user:pw@siem.example/x'), { ok: false, reason: 'credentials' });
  assert.deepEqual(rule.checkDrainUrlShape('not a url'), { ok: false, reason: 'invalid' });
  assert.deepEqual(rule.checkDrainUrlShape(''), { ok: false, reason: 'invalid' });
  assert.deepEqual(rule.checkDrainUrlShape(`https://siem.example/${'a'.repeat(2000)}`), { ok: false, reason: 'too_long' });
});

test('the test batch is synthetic: invented ids and actors, flagged in detail, two rows in order', () => {
  const now = new Date('2026-10-07T06:00:00.000Z');
  const rows = rule.syntheticTestRows('org-a', now);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.match(r.id, /^test-/);
    assert.equal(r.actorId, 'test-actor');
    assert.equal(r.action, 'audit.drain.test');
    assert.equal(r.orgId, 'org-a');
  }
  assert.ok(rows[0].createdAt < rows[1].createdAt);
  assert.deepEqual(JSON.parse(rows[0].detail).test, true);
});

test('the formats catalogue and its guard agree', () => {
  assert.deepEqual([...rule.AUDIT_DRAIN_FORMATS], ['json_lines', 'ecs']);
  assert.equal(rule.isAuditDrainFormat('ecs'), true);
  assert.equal(rule.isAuditDrainFormat('syslog'), false);
  assert.equal(rule.isAuditDrainFormat(null), false);
});
