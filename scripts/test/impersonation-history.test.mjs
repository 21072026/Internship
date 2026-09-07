// Unit tests for the impersonation-session pairing (#1587).
//
// Run: npm run test:impersonation-history  (node --test --experimental-strip-types)
//
// This screen's whole value is being trustworthy about who entered someone's
// account, so every sentence it prints is a factual claim that has to hold.
// The three-state outcome is the part no e2e run can pin down: an unclosed
// start that is five minutes old and an unclosed start that is five hours old
// look identical in the database and mean completely different things, and the
// first version of this card described both of them as "ended automatically" —
// false for the entire thirty-minute window in which the visit may be live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pairImpersonationSessions,
  IMPERSONATION_SESSION_MAX_MS,
} from '../../src/lib/impersonationHistory.ts';

const NOW = new Date('2026-01-01T12:00:00Z').getTime();
const ago = (ms) => new Date(NOW - ms);
const MIN = 60_000;
const names = new Map([['admin-a', 'Ada Admin'], ['admin-b', 'Bo Admin']]);

const start = (id, actorId, createdAt, detail = null) => ({
  id, actorId, action: 'IMPERSONATE_START', detail, createdAt,
});
const stop = (id, actorId, createdAt) => ({
  id, actorId, action: 'IMPERSONATE_STOP', detail: null, createdAt,
});

test('a closed session reports its exact duration', () => {
  const [s] = pairImpersonationSessions(
    [start('s1', 'admin-a', ago(20 * MIN)), stop('x1', 'admin-a', ago(12 * MIN))],
    names,
    NOW,
  );
  assert.equal(s.outcome, 'closed');
  assert.equal(s.durationMs, 8 * MIN);
  assert.equal(s.adminName, 'Ada Admin');
  assert.notEqual(s.endedAt, null);
});

test('an unclosed start inside the cap is open, not "ended automatically"', () => {
  // The regression this file exists for: an admin who entered five minutes ago
  // and is still in there. There is no stop row and there cannot be one yet.
  const [s] = pairImpersonationSessions([start('s1', 'admin-a', ago(5 * MIN))], names, NOW);
  assert.equal(s.outcome, 'open');
  assert.equal(s.endedAt, null);
});

test('an unclosed start past the cap really has expired', () => {
  const [s] = pairImpersonationSessions(
    [start('s1', 'admin-a', new Date(NOW - IMPERSONATION_SESSION_MAX_MS - MIN))],
    names,
    NOW,
  );
  assert.equal(s.outcome, 'autoExpired');
  // Clamped: it cannot have outlived the cap that ended it.
  assert.equal(s.durationMs, IMPERSONATION_SESSION_MAX_MS);
});

test('exactly at the cap the session is expired, not open', () => {
  const [s] = pairImpersonationSessions(
    [start('s1', 'admin-a', new Date(NOW - IMPERSONATION_SESSION_MAX_MS))],
    names,
    NOW,
  );
  assert.equal(s.outcome, 'autoExpired');
});

test('a re-entry by the same admin expires the earlier visit even inside the cap', () => {
  // Both starts are minutes old, so the clock alone would call the first one
  // "open" — but the same admin demonstrably started again, so the first is
  // over, and the second start bounds its length far better than `now` does.
  const sessions = pairImpersonationSessions(
    [start('s1', 'admin-a', ago(9 * MIN)), start('s2', 'admin-a', ago(6 * MIN))],
    names,
    NOW,
  );
  assert.deepEqual(sessions.map((s) => [s.id, s.outcome]), [['s2', 'open'], ['s1', 'autoExpired']]);
  assert.equal(sessions[1].durationMs, 3 * MIN);
});

test('two admins overlapping do not cross-pair', () => {
  const sessions = pairImpersonationSessions(
    [
      start('s1', 'admin-a', ago(40 * MIN)),
      start('s2', 'admin-b', ago(38 * MIN)),
      stop('x2', 'admin-b', ago(36 * MIN)),
      stop('x1', 'admin-a', ago(34 * MIN)),
    ],
    names,
    NOW,
  );
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  assert.equal(byId.s1.durationMs, 6 * MIN);
  assert.equal(byId.s2.durationMs, 2 * MIN);
  assert.equal(byId.s2.adminName, 'Bo Admin');
});

test('an orphan stop is dropped, never shown as a zero-length visit', () => {
  assert.deepEqual(pairImpersonationSessions([stop('x1', 'admin-a', ago(MIN))], names, NOW), []);
});

test('every start yields exactly one session — so counting starts counts sessions', () => {
  // The endpoint returns `total` as a count of START rows and the card prints
  // it as a number of sessions; that only holds if this stays true.
  const rows = [
    stop('x0', 'admin-b', ago(90 * MIN)), // orphan, contributes nothing
    start('s1', 'admin-a', ago(80 * MIN)),
    stop('x1', 'admin-a', ago(70 * MIN)),
    start('s2', 'admin-a', ago(60 * MIN)),
    start('s3', 'admin-b', ago(50 * MIN)),
    start('s4', 'admin-b', ago(3 * MIN)),
  ];
  const sessions = pairImpersonationSessions(rows, names, NOW);
  assert.equal(sessions.length, rows.filter((r) => r.action === 'IMPERSONATE_START').length);
  // Newest first.
  assert.deepEqual(sessions.map((s) => s.id), ['s4', 's3', 's2', 's1']);
});

test('a blank reason is null, and a real one survives verbatim', () => {
  const reason = "Ticket 4711 $& $' refund";
  const sessions = pairImpersonationSessions(
    [start('s1', 'admin-a', ago(MIN), '   '), start('s2', 'admin-b', ago(MIN), ` ${reason} `)],
    names,
    NOW,
  );
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  assert.equal(byId.s1.reason, null);
  assert.equal(byId.s2.reason, reason);
});

test('clock skew cannot produce a negative duration', () => {
  const [s] = pairImpersonationSessions(
    [start('s1', 'admin-a', ago(10 * MIN)), stop('x1', 'admin-a', ago(11 * MIN))],
    names,
    NOW,
  );
  assert.equal(s.durationMs, 0);
});
