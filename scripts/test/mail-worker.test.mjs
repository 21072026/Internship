// Unit tests for the mail outbox rules (#2944): src/lib/mailWorkerRule.ts.
//
// Run: npm run test:unit   (node --test --experimental-strip-types)
//
// What is pinned here, and why each matters:
//   SETTLE     — the drain's whole decision table: a 250 settles, a relay-wide
//                failure (throttle, refused session, timeout) is RELEASED with
//                its attempt count untouched and waits out the pause — but every
//                RELAY_RELEASES_PER_ATTEMPT-th release of one row counts, so no
//                row is released forever — a 4xx
//                about the message retries with backoff and costs an attempt,
//                a 5xx is final, attempts run out into DEAD_LETTER, and a retry
//                that would land after `notAfter` is cancelled as expired.
//   POLICY     — nothing is queued by lane unless MAIL_QUEUE_LANES says so, and
//                CRITICAL can never be listed; the inline cap is clamped; the
//                worker is on unless switched off.
//   LIFETIME   — a caller may shorten a mail's life, never extend it.
//   BREAKER    — only a pause that has not run out opens it, never a busy
//                meter: in observe mode `tat` carries every send and can sit
//                hours ahead with no pause at all (a reset link would expire
//                behind it).
//   ENVELOPE   — attachments survive the JSON round trip as bytes; an
//                oversized one is not queueable; garbage decodes to null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const W = await import('../../src/lib/mailWorkerRule.ts');
const R = await import('../../src/lib/mailDeliveryRule.ts');

const NOW = new Date('2026-10-16T09:30:00.000Z');
const LADDER = R.DEFAULT_LADDER_SEC;
const mid = () => 0.5;

const throttle = { responseCode: 450, response: '450 4.7.1 Error: too much mail from 192.0.2.1', command: 'MAIL FROM' };
const timeout = { code: 'ETIMEDOUT', message: 'Greeting never received' };
const mailboxBusy = { responseCode: 452, response: '452 4.2.2 Mailbox full', command: 'RCPT TO' };
const rejected = { responseCode: 550, response: '550 5.1.1 User unknown', command: 'RCPT TO' };

function settle(error, over = {}) {
  return W.settleAction({ error, lane: 'CRITICAL', attempts: 0, maxAttempts: 5, now: NOW, ladderSec: LADDER, random: mid, ...over });
}

// ── Settle ───────────────────────────────────────────────────────────────────

test('settle: a 250 is sent', () => {
  assert.deepEqual(settle(null), { kind: 'sent' });
});

test('settle: a relay throttle releases the row without charging an attempt', () => {
  const a = settle(throttle, { attempts: 3 });
  assert.equal(a.kind, 'release');
  assert.equal(a.runAt.getTime(), NOW.getTime() + 60_000, 'at least the first rung of the ladder');
  assert.equal(a.attempts, 3, 'no attempt is charged');
  assert.equal(a.releases, 1);
});

test('settle: every RELAY_RELEASES_PER_ATTEMPT-th release costs one attempt, and the row can die of it', () => {
  const n = W.RELAY_RELEASES_PER_ATTEMPT;
  assert.ok(n >= 2);
  // Releases below the threshold are free.
  for (let r = 0; r < n - 1; r++) {
    const a = settle(timeout, { attempts: 1, releases: r });
    assert.equal(a.kind, 'release');
    assert.equal(a.attempts, 1, `release ${r + 1} is free`);
    assert.equal(a.releases, r + 1);
  }
  const charged = settle(timeout, { attempts: 1, releases: n - 1 });
  assert.equal(charged.kind, 'release');
  assert.equal(charged.attempts, 2, 'the n-th release counts');
  // A row that only ever fails "relay-wide" is not released without limit.
  const dead = settle(timeout, { attempts: 4, maxAttempts: 5, releases: n - 1 });
  assert.equal(dead.kind, 'dead');
  assert.equal(dead.status, 'DEAD_LETTER');
  assert.match(dead.reason, /:releases$/);
  // Walked from zero: dead after exactly maxAttempts × n relay-wide failures.
  let attempts = 0;
  let releases = 0;
  let steps = 0;
  for (;;) {
    const a = settle(throttle, { attempts, releases, maxAttempts: 5 });
    steps++;
    if (a.kind !== 'release') {
      assert.equal(a.kind, 'dead');
      break;
    }
    attempts = a.attempts;
    releases = a.releases;
    assert.ok(steps < 1000);
  }
  assert.equal(steps, 5 * n);
});

test('settle: a release waits out the paused budget when it is longer', () => {
  const pausedUntil = new Date(NOW.getTime() + 5 * 60_000);
  assert.equal(settle(timeout, { pausedUntil }).runAt.getTime(), pausedUntil.getTime());
  // A pause shorter than the floor does not shorten it.
  assert.equal(settle(timeout, { pausedUntil: new Date(NOW.getTime() + 1000) }).runAt.getTime(), NOW.getTime() + 60_000);
  // An invalid instant is ignored.
  assert.equal(settle(timeout, { pausedUntil: new Date('nope') }).runAt.getTime(), NOW.getTime() + 60_000);
});

test('settle: a release that would outlive the mail expires it instead', () => {
  const a = settle(throttle, { notAfter: new Date(NOW.getTime() + 30_000).toISOString(), attempts: 2 });
  assert.equal(a.kind, 'expired');
  assert.equal(a.attempts, 2, 'still not charged');
});

test('settle: a 4xx about the message retries with backoff and costs one attempt', () => {
  const a = settle(mailboxBusy, { attempts: 1 });
  assert.equal(a.kind, 'retry');
  assert.equal(a.attempts, 2);
  // CRITICAL retry 2: ceiling 30 s, equal jitter at 0.5 → 22.5 s.
  assert.equal(a.runAt.getTime() - NOW.getTime(), R.retryDelayMs(2, 'CRITICAL', mid));
  // Bulk backs off much further.
  const bulk = settle(mailboxBusy, { attempts: 1, lane: 'BULK' });
  assert.ok(bulk.runAt.getTime() - NOW.getTime() > a.runAt.getTime() - NOW.getTime());
});

test('settle: a 5xx is final (FAILED), never retried', () => {
  const a = settle(rejected, { attempts: 0 });
  assert.equal(a.kind, 'dead');
  assert.equal(a.status, 'FAILED');
  assert.equal(a.attempts, 1);
});

test('settle: the last attempt dead-letters a mail that keeps getting a 4xx', () => {
  const a = settle(mailboxBusy, { attempts: 4, maxAttempts: 5 });
  assert.equal(a.kind, 'dead');
  assert.equal(a.status, 'DEAD_LETTER');
  assert.equal(a.attempts, 5);
  assert.match(a.reason, /:attempts$/);
  // A nonsensical maxAttempts still ends it.
  assert.equal(settle(mailboxBusy, { attempts: 0, maxAttempts: 0 }).kind, 'dead');
});

test('settle: a retry that would land after notAfter is cancelled as expired', () => {
  const a = settle(mailboxBusy, { attempts: 0, notAfter: new Date(NOW.getTime() + 1_000).toISOString() });
  assert.equal(a.kind, 'expired');
  assert.equal(a.attempts, 1, 'the attempt that just failed counts');
  // An unreadable notAfter does not expire anything.
  assert.equal(settle(mailboxBusy, { notAfter: 'not-a-date' }).kind, 'retry');
});

test('settle: an unrecognisable error is retried, bounded by attempts', () => {
  assert.equal(settle(new Error('builder blew up')).kind, 'retry');
});

// ── The first queued try after an inline failure ─────────────────────────────

test('firstQueuedRunAt: relay-wide waits a rung, a message retry the lane backoff', () => {
  const cfg = R.budgetConfig({});
  const relay = W.firstQueuedRunAt(R.classifySmtpError(throttle), 'CRITICAL', NOW, cfg);
  assert.equal(relay.getTime() - NOW.getTime(), 60_000);
  const msg = W.firstQueuedRunAt(R.classifySmtpError(mailboxBusy), 'TRANSACTIONAL', NOW, cfg, mid);
  assert.equal(msg.getTime() - NOW.getTime(), R.retryDelayMs(1, 'TRANSACTIONAL', mid));
});

// ── Policy ───────────────────────────────────────────────────────────────────

test('policy: nothing is queued by lane by default; the worker is on', () => {
  const p = W.mailPolicy({});
  assert.equal(p.queueLanes.size, 0);
  assert.equal(p.workerEnabled, true);
  assert.equal(p.inlineTimeoutMs, W.DEFAULT_INLINE_TIMEOUT_MS);
});

test('policy: MAIL_QUEUE_LANES reads TRANSACTIONAL and BULK, never CRITICAL', () => {
  const p = W.mailPolicy({ MAIL_QUEUE_LANES: ' transactional , BULK, CRITICAL, nonsense,' });
  assert.deepEqual([...p.queueLanes].sort(), ['BULK', 'TRANSACTIONAL']);
});

test('policy: the inline cap is clamped to 1–30 s', () => {
  assert.equal(W.mailPolicy({ MAIL_INLINE_TIMEOUT_MS: '200' }).inlineTimeoutMs, 1_000);
  assert.equal(W.mailPolicy({ MAIL_INLINE_TIMEOUT_MS: '999999' }).inlineTimeoutMs, 30_000);
  assert.equal(W.mailPolicy({ MAIL_INLINE_TIMEOUT_MS: '2500.7' }).inlineTimeoutMs, 2_500);
  assert.equal(W.mailPolicy({ MAIL_INLINE_TIMEOUT_MS: 'soon' }).inlineTimeoutMs, W.DEFAULT_INLINE_TIMEOUT_MS);
  assert.equal(W.mailPolicy({ MAIL_INLINE_TIMEOUT_MS: ' ' }).inlineTimeoutMs, W.DEFAULT_INLINE_TIMEOUT_MS);
});

test('policy: MAIL_WORKER_ENABLED switches the drain off only on an explicit no', () => {
  for (const v of ['0', 'false', 'OFF', ' no ']) assert.equal(W.mailPolicy({ MAIL_WORKER_ENABLED: v }).workerEnabled, false, v);
  for (const v of ['1', 'true', '', 'yes']) assert.equal(W.mailPolicy({ MAIL_WORKER_ENABLED: v }).workerEnabled, true, v);
});

// ── Lifetime ────────────────────────────────────────────────────────────────

test('notAfter: the lane maximum, or the caller deadline when it is earlier', () => {
  assert.equal(W.notAfterFor('BULK', NOW).getTime(), NOW.getTime() + R.LANE_MAX_AGE_MS.BULK);
  const soon = new Date(NOW.getTime() + 15 * 60_000);
  assert.equal(W.notAfterFor('CRITICAL', NOW, soon).getTime(), soon.getTime());
  const late = new Date(NOW.getTime() + 30 * 24 * 60 * 60_000);
  assert.equal(W.notAfterFor('TRANSACTIONAL', NOW, late).getTime(), NOW.getTime() + R.LANE_MAX_AGE_MS.TRANSACTIONAL, 'never extended');
  assert.equal(W.notAfterFor('CRITICAL', NOW, new Date('x')).getTime(), NOW.getTime() + R.LANE_MAX_AGE_MS.CRITICAL);
});

test('isExpired: past, future, missing and unreadable', () => {
  assert.equal(W.isExpired(new Date(NOW.getTime() - 1).toISOString(), NOW), true);
  assert.equal(W.isExpired(NOW.toISOString(), NOW), true);
  assert.equal(W.isExpired(new Date(NOW.getTime() + 1).toISOString(), NOW), false);
  assert.equal(W.isExpired(null, NOW), false);
  assert.equal(W.isExpired('garbage', NOW), false);
});

// ── Breaker ─────────────────────────────────────────────────────────────────

test('breaker: opens only while a relay pause runs, never on a busy meter', () => {
  const cfg = R.budgetConfig({ MAIL_RATE_PER_MIN: '2', MAIL_BURST: '2', MAIL_URGENT_RESERVE: '1' });
  assert.equal(cfg.mode, 'observe');
  assert.equal(W.breakerOpen(null, cfg), false, 'no row: closed');
  assert.equal(W.breakerOpen({ aheadMs: 600_000, pausedMs: 0, pauseLevel: 0 }, cfg), false, 'busy, not paused: closed');
  assert.equal(W.breakerOpen({ aheadMs: 60_000, pausedMs: 60_000, pauseLevel: 1 }, cfg), true, 'paused for a minute: open');
  assert.equal(W.breakerOpen({ aheadMs: 60_000, pausedMs: 60_000, pauseLevel: 1 }, { ...cfg, mode: 'off' }), false, 'off never opens');
  assert.equal(W.breakerWaitMs({ aheadMs: 60_000, pausedMs: 45_000, pauseLevel: 1 }, cfg), 45_000, 'waits the pause, not tat');
  assert.equal(W.breakerWaitMs({ aheadMs: 60_000, pausedMs: 0, pauseLevel: 0 }, cfg), 0);
});

test('breaker: observe mode, tat hours ahead after a burst, rung raised, pause over → closed (the critical send is tried)', () => {
  // A 300-mail burst at 2/min puts tat ~150 min ahead; a later throttle raised
  // the rung. Once the pause itself has run out, a password reset must be tried
  // inline — it must not wait out the meter's 150 minutes and expire.
  const cfg = R.budgetConfig({});
  const state = { aheadMs: 150 * 60_000, pausedMs: -5_000, pauseLevel: 1 };
  assert.equal(W.breakerOpen(state, cfg), false);
  assert.equal(W.breakerWaitMs(state, cfg), 0);
  // While the pause runs, it waits the pause (a minute), not tat.
  assert.equal(W.breakerWaitMs({ ...state, pausedMs: 60_000 }, cfg), 60_000);
  assert.equal(W.breakerOpen({ ...state, pausedMs: Number.NaN }, cfg), false, 'an unreadable pause is closed');
});

// ── Envelope ────────────────────────────────────────────────────────────────

const envelope = {
  to: 'person@example.test',
  subject: 'Reset your password',
  category: 'password-reset',
  transport: 'primary',
  lane: 'CRITICAL',
  group: 'account_security',
  userId: 'u1',
  orgId: null,
  world: null,
  message: {
    from: { name: 'App', address: 'noreply@example.test' },
    to: 'person@example.test',
    subject: 'Reset your password',
    html: '<p>hi</p>',
    text: 'hi',
    headers: { 'X-Test': '1' },
    attachments: [
      { filename: 'a.ics', content: Buffer.from([0, 1, 2, 250, 255]), contentType: 'text/calendar', cid: 'c1' },
      { content: 'plain string' },
    ],
  },
};

test('envelope: round-trips, attachments as bytes', () => {
  const back = W.decodeEnvelope(W.encodeEnvelope(envelope));
  assert.equal(back.to, envelope.to);
  assert.equal(back.lane, 'CRITICAL');
  assert.deepEqual(back.message.from, envelope.message.from);
  assert.deepEqual(back.message.headers, { 'X-Test': '1' });
  assert.ok(Buffer.isBuffer(back.message.attachments[0].content));
  assert.deepEqual([...back.message.attachments[0].content], [0, 1, 2, 250, 255]);
  assert.equal(back.message.attachments[0].filename, 'a.ics');
  assert.equal(back.message.attachments[0].contentType, 'text/calendar');
  assert.equal(back.message.attachments[0].cid, 'c1');
  assert.equal(back.message.attachments[1].content.toString(), 'plain string');
  assert.ok(!('filename' in back.message.attachments[1]));
});

test('envelope: a mail without attachments carries none', () => {
  const { attachments: _drop, ...message } = envelope.message;
  const back = W.decodeEnvelope(W.encodeEnvelope({ ...envelope, message }));
  assert.ok(!('attachments' in back.message));
});

test('envelope: garbage, foreign shapes and missing fields decode to null', () => {
  for (const bad of [null, '', 'not json', '42', '{}', JSON.stringify({ to: 'x', subject: 's' })]) {
    assert.equal(W.decodeEnvelope(bad), null, String(bad));
  }
  const good = JSON.parse(W.encodeEnvelope(envelope));
  assert.equal(W.decodeEnvelope(JSON.stringify({ ...good, transport: 'carrier-pigeon' })), null);
  assert.equal(W.decodeEnvelope(JSON.stringify({ ...good, lane: 'URGENT' })), null);
  // An attachment whose bytes went missing reads back empty, not as a crash.
  good.message.attachments = [{ filename: 'x' }];
  assert.equal(W.decodeEnvelope(JSON.stringify(good)).message.attachments[0].content.length, 0);
});

test('envelope: attachments over the cap are not queueable', () => {
  assert.equal(W.queueable(envelope), true);
  const big = { message: { attachments: [{ content: Buffer.alloc(W.MAX_QUEUED_ATTACHMENT_BYTES + 1) }] } };
  assert.equal(W.queueable(big), false);
  assert.equal(W.attachmentBytes({}), 0);
  assert.equal(W.attachmentBytes({ attachments: [{ content: 'héllo' }] }), 6);
});

// ── Identity ────────────────────────────────────────────────────────────────

test('fallbackRef: same body in the same minute is one mail; a new link is another', () => {
  const a = W.fallbackRef(NOW, '<a href="https://x/reset?t=1">reset</a>');
  assert.equal(a, W.fallbackRef(new Date(NOW.getTime() + 20_000), '<a href="https://x/reset?t=1">reset</a>'));
  assert.notEqual(a, W.fallbackRef(NOW, '<a href="https://x/reset?t=2">reset</a>'));
  assert.notEqual(a, W.fallbackRef(new Date(NOW.getTime() + 60_000), '<a href="https://x/reset?t=1">reset</a>'));
  assert.ok(!a.includes('reset'), 'the body is hashed, never carried');
  // And the key built from it is bounded and carries no address.
  const key = R.dedupeKeyFor({ kind: 'fallback', category: 'password-reset', to: 'person@example.test', subject: 's', ref: a, at: NOW });
  assert.ok(key.length <= 191 && !key.includes('@'));
});

test('constants: the job name fits Job.name and matches the queue union', async () => {
  const T = await import('../../src/lib/jobs/types.ts');
  assert.ok(T.JOB_NAMES.includes(W.MAIL_JOB_NAME));
  assert.ok(W.MAIL_JOB_NAME.length <= T.JOB_NAME_MAX_LENGTH);
  assert.ok(W.INLINE_FALLBACK_DELAY_MS > 3_000 + 3_000 + 5_000, 'the queued copy waits past the urgent transport timeouts');
});
