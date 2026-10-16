// Unit tests for the mail queue's operations rules (#2953):
// src/lib/mailOpsRule.ts and src/lib/mailSinkRule.ts.
//
// Run: npm run test:unit   (node --test --experimental-strip-types)
//
// What is pinned here, and why each matters:
//   ALERTS     — the three operator alerts fire on their thresholds and not one
//                second before: a critical mail queued 5 minutes ago is not yet
//                an alert (the inline-timeout copy waits 30 s by design), a
//                relay pause that has not run for 15 minutes is a throttle, not
//                an outage — and a pause with no recorded outage start never
//                alerts at all.
//   AUTH       — only a credentials rejection is EAUTH; a 535 that arrived as a
//                session-stage refusal counts too, a 550 about a mailbox does not.
//   ACTIONS    — retry only a FAILED/DEAD_LETTER row whose deadline has not
//                passed and whose envelope is still there; cancel only PENDING
//                (never RUNNING, which a drain holds).
//   SCOPE      — a super admin sees their world, the default organization's
//                ADMIN its own rows, every other admin nothing.
//   NO PII     — a reason that is not code-shaped is shown as `other`, and only
//                a 12-character prefix of a real hex hash leaves.
//   SINK       — the allowlist parses addresses and domains (exact, never a
//                subdomain), a typo narrows it, and a mail goes to the relay only
//                when EVERY recipient is allowlisted; with no sink, always relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const O = await import('../../src/lib/mailOpsRule.ts');
const S = await import('../../src/lib/mailSinkRule.ts');

const NOW = new Date('2026-10-16T10:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

// ── ALERTS ───────────────────────────────────────────────────────────────────

test('critical waiting: strictly more than 5 minutes', () => {
  const base = { now: NOW, breakers: [], authRejected: false };
  assert.deepEqual(O.mailOpsAlertsDue({ ...base, oldestCriticalQueuedAt: null }), []);
  assert.deepEqual(O.mailOpsAlertsDue({ ...base, oldestCriticalQueuedAt: ago(5 * MIN) }), []);
  assert.deepEqual(O.mailOpsAlertsDue({ ...base, oldestCriticalQueuedAt: ago(5 * MIN + 1) }), ['mail-critical-waiting']);
  // The inline-timeout copy's own hold is far below the threshold.
  assert.ok(O.CRITICAL_PENDING_ALERT_MS > 30_000 * 2);
});

test('breaker open: a running pause whose outage is older than 15 minutes', () => {
  const base = { now: NOW, oldestCriticalQueuedAt: null, authRejected: false };
  const due = (b) => O.mailOpsAlertsDue({ ...base, breakers: [b] });
  assert.deepEqual(due({ channel: 'primary', paused: true, outageMs: 15 * MIN }), []);
  assert.deepEqual(due({ channel: 'primary', paused: true, outageMs: 15 * MIN + 1 }), ['mail-breaker-open']);
  // The pause ran out (the probe moment): no alert on this evaluation.
  assert.deepEqual(due({ channel: 'primary', paused: false, outageMs: 60 * MIN }), []);
  // No recorded outage start: never.
  assert.deepEqual(due({ channel: 'primary', paused: true, outageMs: null }), []);
  // Either channel is enough.
  assert.deepEqual(
    O.mailOpsAlertsDue({
      ...base,
      breakers: [
        { channel: 'primary', paused: false, outageMs: null },
        { channel: 'bulk', paused: true, outageMs: 20 * MIN },
      ],
    }),
    ['mail-breaker-open'],
  );
  // The default ladder's first three rungs (1+2+5 min) stay under the threshold.
  assert.ok((60 + 120 + 300) * 1000 < O.BREAKER_OPEN_ALERT_MS);
});

test('all three can be due at once, in a fixed order', () => {
  assert.deepEqual(
    O.mailOpsAlertsDue({
      now: NOW,
      oldestCriticalQueuedAt: ago(10 * MIN),
      breakers: [{ channel: 'primary', paused: true, outageMs: 30 * MIN }],
      authRejected: true,
    }),
    ['mail-critical-waiting', 'mail-breaker-open', 'mail-relay-auth'],
  );
});

test('auth rejection: EAUTH, ENOAUTH and a refusal at the AUTH step — nothing else', () => {
  assert.equal(O.isAuthRejection('EAUTH'), true);
  assert.equal(O.isAuthRejection('ENOAUTH'), true);
  assert.equal(O.isAuthRejection('smtp_535_5.7.8@AUTH_PLAIN'), true);
  assert.equal(O.isAuthRejection('smtp_535@AUTH'), true);
  assert.equal(O.isAuthRejection('smtp_550_5.1.1'), false);
  assert.equal(O.isAuthRejection('ECONNREFUSED'), false);
  assert.equal(O.isAuthRejection('smtp_421@EHLO'), false);
  assert.equal(O.isAuthRejection(null), false);
  assert.equal(O.isAuthRejection(''), false);
});

// ── LANES AND COUNTS ─────────────────────────────────────────────────────────

test('lane bands from priority match lanePriority()', () => {
  assert.equal(O.laneOfPriority(100), 'CRITICAL');
  assert.equal(O.laneOfPriority(150), 'CRITICAL');
  assert.equal(O.laneOfPriority(50), 'TRANSACTIONAL');
  assert.equal(O.laneOfPriority(99), 'TRANSACTIONAL');
  assert.equal(O.laneOfPriority(20), 'BULK');
  assert.equal(O.laneOfPriority(0), 'BULK');
  assert.equal(O.laneOfPriority(-5), 'BULK');
});

test('payload lane: an unknown value reads as CRITICAL', () => {
  assert.equal(O.laneOfPayload({ lane: 'BULK' }), 'BULK');
  assert.equal(O.laneOfPayload({ lane: 'nope' }), 'CRITICAL');
  assert.equal(O.laneOfPayload(null), 'CRITICAL');
});

test('counts fold into the fixed shape; unknown states are dropped', () => {
  const c = O.foldLaneCounts([
    { lane: 'BULK', status: 'PENDING', count: 3 },
    { lane: 'BULK', status: 'PENDING', count: 2 },
    { lane: 'CRITICAL', status: 'DEAD_LETTER', count: 1 },
    { lane: 'TRANSACTIONAL', status: 'WEIRD', count: 9 },
  ]);
  assert.equal(c.BULK.PENDING, 5);
  assert.equal(c.CRITICAL.DEAD_LETTER, 1);
  assert.equal(Object.values(c.TRANSACTIONAL).reduce((a, b) => a + b, 0), 0);
  assert.deepEqual(Object.keys(c.CRITICAL), [...O.QUEUE_STATES]);
});

// ── NO PII ───────────────────────────────────────────────────────────────────

test('a reason is a code or `other`, never free text', () => {
  assert.equal(O.reasonCodeOf('smtp_550_5.1.1'), 'smtp_550_5.1.1');
  assert.equal(O.reasonCodeOf('EAUTH:releases'), 'EAUTH:releases');
  assert.equal(O.reasonCodeOf('smtp_535_5.7.8@AUTH_PLAIN'), 'smtp_535_5.7.8@AUTH_PLAIN');
  assert.equal(O.reasonCodeOf('550 <someone@example.com> no such user'), 'other');
  assert.equal(O.reasonCodeOf('x'.repeat(65)), 'other');
  assert.equal(O.reasonCodeOf(null), null);
});

test('the recipient fingerprint is a 12-character prefix of a hex hash, or nothing', () => {
  const h = 'a'.repeat(64);
  assert.equal(O.recipientPrefix(h), 'a'.repeat(12));
  assert.equal(O.recipientPrefix('someone@example.com'), null);
  assert.equal(O.recipientPrefix('ABCDEF0123456789'), null);
  assert.equal(O.recipientPrefix(undefined), null);
});

// ── ACTIONS ──────────────────────────────────────────────────────────────────

test('retry: FAILED or DEAD_LETTER, before notAfter, with the envelope', () => {
  const later = new Date(NOW.getTime() + MIN).toISOString();
  const row = (o) => ({ status: 'DEAD_LETTER', notAfter: later, hasEnvelope: true, ...o });
  assert.equal(O.queueActionAllowed('retry', row({}), NOW), true);
  assert.equal(O.queueActionAllowed('retry', row({ status: 'FAILED' }), NOW), true);
  for (const status of ['PENDING', 'RUNNING', 'SUCCEEDED', 'CANCELLED']) {
    assert.equal(O.queueActionAllowed('retry', row({ status }), NOW), 'wrong_state');
  }
  assert.equal(O.queueActionAllowed('retry', row({ notAfter: NOW.toISOString() }), NOW), 'expired');
  assert.equal(O.queueActionAllowed('retry', row({ notAfter: null }), NOW), 'expired');
  assert.equal(O.queueActionAllowed('retry', row({ notAfter: 'garbage' }), NOW), 'expired');
  assert.equal(O.queueActionAllowed('retry', row({ hasEnvelope: false }), NOW), 'no_envelope');
});

test('cancel: PENDING only — never a row a drain holds', () => {
  const row = (status) => ({ status, notAfter: null, hasEnvelope: true });
  assert.equal(O.queueActionAllowed('cancel', row('PENDING'), NOW), true);
  for (const status of ['RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELLED']) {
    assert.equal(O.queueActionAllowed('cancel', row(status), NOW), 'wrong_state');
  }
});

// ── SCOPE ────────────────────────────────────────────────────────────────────

test('who sees which rows', () => {
  const base = { defaultOrgId: 'org-default', defaultWorld: 'INTERNSHIP' };
  // A super admin: their world; the org-less rows only in the default world.
  assert.deepEqual(O.queueScopeFor({ ...base, role: 'ADMIN', superAdminWorld: 'INTERNSHIP', orgId: 'org-x' }), {
    kind: 'world',
    world: 'INTERNSHIP',
    includeOrgless: true,
  });
  assert.deepEqual(O.queueScopeFor({ ...base, role: 'ADMIN', superAdminWorld: 'MARKETING', orgId: 'org-m' }), {
    kind: 'world',
    world: 'MARKETING',
    includeOrgless: false,
  });
  // The default organization's ADMIN: its own rows and the org-less ones.
  assert.deepEqual(O.queueScopeFor({ ...base, role: 'ADMIN', superAdminWorld: null, orgId: 'org-default' }), {
    kind: 'org',
    orgId: 'org-default',
    includeOrgless: true,
  });
  // Any other tenant's ADMIN, an org-less ADMIN, and every other role: nothing.
  assert.equal(O.queueScopeFor({ ...base, role: 'ADMIN', superAdminWorld: null, orgId: 'org-tenant' }), null);
  assert.equal(O.queueScopeFor({ ...base, role: 'ADMIN', superAdminWorld: null, orgId: null }), null);
  for (const role of ['MENTOR', 'MENTEE', 'COMPANY', 'SOURCE', undefined]) {
    assert.equal(O.queueScopeFor({ ...base, role, superAdminWorld: 'INTERNSHIP', orgId: 'org-default' }), null);
  }
});

// ── SINK ─────────────────────────────────────────────────────────────────────

test('allowlist: addresses and exact domains; junk is ignored', () => {
  const l = S.parseRecipientAllowlist(' Owner@Example.com, example.org;@team.example.net  not-a-domain, @, a@b, x@@y.com ');
  assert.deepEqual([...l.addresses].sort(), ['owner@example.com']);
  assert.deepEqual([...l.domains].sort(), ['example.org', 'team.example.net']);
  assert.equal(S.addressAllowed('owner@example.com', l), true);
  assert.equal(S.addressAllowed('OWNER@EXAMPLE.COM', l), true);
  assert.equal(S.addressAllowed('other@example.com', l), false);
  assert.equal(S.addressAllowed('anyone@example.org', l), true);
  // A subdomain is a different mail system.
  assert.equal(S.addressAllowed('anyone@sub.example.org', l), false);
  assert.equal(S.addressAllowed('anyone@example.org.evil.test', l), false);
  assert.equal(S.parseRecipientAllowlist('').addresses.size, 0);
  assert.equal(S.parseRecipientAllowlist(undefined).domains.size, 0);
});

test('recipients: bare, named and comma lists', () => {
  assert.deepEqual(S.recipientsOf('a@x.test'), ['a@x.test']);
  assert.deepEqual(S.recipientsOf('Some One <A@X.test>, b@y.test'), ['a@x.test', 'b@y.test']);
  assert.deepEqual(S.recipientsOf('no address here'), []);
  assert.deepEqual(S.recipientsOf(''), []);
});

test('route: relay only when every recipient is allowlisted; no sink means relay', () => {
  const l = S.parseRecipientAllowlist('owner@example.com, example.org');
  assert.equal(S.mailRouteFor('stranger@example.net', '', l), 'relay');
  assert.equal(S.mailRouteFor('stranger@example.net', undefined, l), 'relay');
  assert.equal(S.mailRouteFor('stranger@example.net', '127.0.0.1', l), 'sink');
  assert.equal(S.mailRouteFor('owner@example.com', '127.0.0.1', l), 'relay');
  assert.equal(S.mailRouteFor('Team <x@example.org>', '127.0.0.1', l), 'relay');
  // One stranger sends the whole mail to the sink.
  assert.equal(S.mailRouteFor('owner@example.com, stranger@example.net', '127.0.0.1', l), 'sink');
  // Nothing recognisable: the sink, never the relay.
  assert.equal(S.mailRouteFor('', '127.0.0.1', l), 'sink');
  // An empty allowlist: everything to the sink.
  assert.equal(S.mailRouteFor('owner@example.com', '127.0.0.1', S.parseRecipientAllowlist('')), 'sink');
});
