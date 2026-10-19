// Unit tests for the mail delivery rules (#2941): src/lib/mailDeliveryRule.ts.
//
// Run: npm run test:unit   (node --test --experimental-strip-types)
//
// What is pinned here, and why each matters:
//   LANES      — read from the emailGroups taxonomy and nothing else; an unknown
//                category is CRITICAL (a gap must never make a sign-in mail
//                wait); a caller may lower a lane, never raise one.
//   ERRORS     — a relay throttle (the `450 4.7.1 … too much mail` that lost
//                three reminders a day) and a connection/auth failure are
//                RELAY-WIDE: they pause everybody and are not charged to the
//                message. EAUTH arrives as a 535 and must still read as
//                relay-wide. Another 4xx retries the message; a 5xx is final.
//   BUDGET     — the GCRA arithmetic the store's conditional UPDATE mirrors:
//                rate, burst, and a reserve the waiting lanes can never spend.
//   LADDER     — a throttle escalates the pause, a delivery decays it.
//   KEYS       — natural de-duplication keys are stable, bounded and carry no
//                address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const R = await import('../../src/lib/mailDeliveryRule.ts');
const { EMAIL_GROUPS } = await import('../../src/lib/emailGroups.ts');

// ── Lanes ────────────────────────────────────────────────────────────────────

test('lane: every account_security category is CRITICAL', () => {
  for (const c of ['verification', 'password-reset', 'invitation', 'account', 'security', 'ops-alert', 'test', 'consent']) {
    assert.equal(R.laneFor(c), 'CRITICAL', c);
  }
});

test('lane: unknown or missing category fails safe to CRITICAL', () => {
  assert.equal(R.laneFor(undefined), 'CRITICAL');
  assert.equal(R.laneFor(null), 'CRITICAL');
  assert.equal(R.laneFor(''), 'CRITICAL');
  assert.equal(R.laneFor('no-such-category'), 'CRITICAL');
});

test('lane: person-to-person groups are TRANSACTIONAL', () => {
  for (const c of ['message', 'mentor-direct', 'mentorship-request', 'offer', 'meeting-invite', 'meeting-guest-invite', 'public-contact']) {
    assert.equal(R.laneFor(c), 'TRANSACTIONAL', c);
  }
});

test('lane: meeting reminders are time-bound, so TRANSACTIONAL despite the bulk channel', () => {
  for (const c of ['meeting-reminder', 'meeting-guest-reminder', 'meeting-series-reminder']) {
    assert.equal(R.laneFor(c), 'TRANSACTIONAL', c);
  }
});

test('lane: automated volume is BULK', () => {
  for (const c of ['unread-digest', 'activity-digest', 'interaction-reminder', 'weekly-report', 'analytics-report', 'company-need-alert', 'newsletter', 'survey-invite', 'announcement', 'dormant-check-in']) {
    assert.equal(R.laneFor(c), 'BULK', c);
  }
});

test('lane: derived from the taxonomy for every category of every group', () => {
  for (const g of EMAIL_GROUPS) {
    for (const c of g.categories) {
      const expected = g.essential ? 'CRITICAL' : g.id === 'meeting_reminders' ? 'TRANSACTIONAL' : g.bulk ? 'BULK' : 'TRANSACTIONAL';
      assert.equal(R.laneFor(c), expected, `${g.id}/${c}`);
    }
  }
  assert.deepEqual([...R.MAIL_LANES], ['CRITICAL', 'TRANSACTIONAL', 'BULK']);
});

test('lane: a caller may lower a lane but never raise it', () => {
  assert.equal(R.effectiveLane('invitation', 'TRANSACTIONAL'), 'TRANSACTIONAL');
  assert.equal(R.effectiveLane('invitation', 'BULK'), 'BULK');
  assert.equal(R.effectiveLane('newsletter', 'CRITICAL'), 'BULK');
  assert.equal(R.effectiveLane('message', 'CRITICAL'), 'TRANSACTIONAL');
  assert.equal(R.effectiveLane('message', null), 'TRANSACTIONAL');
  assert.equal(R.effectiveLane('message', undefined), 'TRANSACTIONAL');
  assert.equal(R.effectiveLane('message', 'NOT_A_LANE'), 'TRANSACTIONAL');
});

test('priority: critical > transactional > nudges > published content', () => {
  assert.equal(R.lanePriority('CRITICAL', 'password-reset'), 100);
  assert.equal(R.lanePriority('TRANSACTIONAL', 'meeting-reminder'), 50);
  assert.equal(R.lanePriority('BULK', 'unread-digest'), 20);
  assert.equal(R.lanePriority('BULK', 'weekly-report'), 20);
  assert.equal(R.lanePriority('BULK', 'newsletter'), 0);
  assert.equal(R.lanePriority('BULK', 'announcement'), 0);
  assert.equal(R.lanePriority('BULK', 'survey-invite'), 0);
  assert.equal(R.lanePriority('BULK', undefined), 20);
});

test('max age: transactional mail expires before bulk mail', () => {
  assert.ok(R.LANE_MAX_AGE_MS.TRANSACTIONAL < R.LANE_MAX_AGE_MS.BULK);
  assert.equal(R.LANE_MAX_AGE_MS.CRITICAL, 24 * 3600 * 1000);
});

// ── SMTP error classes ───────────────────────────────────────────────────────

test('errors: the relay throttle seen in production is relay-wide', () => {
  const e = Object.assign(new Error('Mail command failed: 450 4.7.1 Error: too much mail from 192.0.2.10'), {
    code: 'EENVELOPE',
    responseCode: 450,
    response: '450 4.7.1 Error: too much mail from 192.0.2.10',
  });
  const c = R.classifySmtpError(e);
  assert.equal(c.kind, 'throttle');
  assert.equal(c.relayWide, true);
  assert.equal(c.retryable, true);
  assert.equal(c.reason, 'smtp_450_4.7.1');
  assert.ok(!c.reason.includes('192.0.2.10'), 'the reason never carries server text');
});

test('errors: 421 is a throttle; 45x with 4.7.x or rate wording too', () => {
  assert.equal(R.classifySmtpError({ responseCode: 421, response: '421 4.3.2 Service shutting down' }).kind, 'throttle');
  assert.equal(R.classifySmtpError({ responseCode: 451, response: '451 4.7.0 Temporary policy' }).kind, 'throttle');
  assert.equal(R.classifySmtpError({ responseCode: 452, response: '452 Too many messages, slow down' }).kind, 'throttle');
  assert.equal(R.classifySmtpError({ responseCode: 450, response: '450 rate limit reached' }).kind, 'throttle');
});

test('errors: a reply code only in the message text is still read', () => {
  const c = R.classifySmtpError(new Error('Mail command failed: 450 4.7.1 Error: too much mail'));
  assert.equal(c.kind, 'throttle');
  assert.equal(R.classifySmtpError(new Error('Data command failed: 554 5.7.1 rejected')).kind, 'permanent');
});

test('errors: connection, timeout, TLS and auth failures are relay-wide', () => {
  for (const code of ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND']) {
    const c = R.classifySmtpError({ code, message: 'boom' });
    assert.equal(c.kind, 'relay', code);
    assert.equal(c.relayWide, true, code);
    assert.equal(c.reason, code);
  }
  // EAUTH carries a 535 — it must not be read as a 5xx about the message.
  const auth = R.classifySmtpError({ code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Authentication failed' });
  assert.equal(auth.kind, 'relay');
  assert.equal(auth.retryable, true);
  assert.equal(R.classifySmtpError({ code: 'eauth' }).kind, 'relay', 'case-insensitive');
});

test('errors: a message-specific 4xx retries the message only', () => {
  for (const [code, text] of [
    [450, '450 4.2.1 Mailbox busy'],
    [452, '452 4.2.2 Mailbox full, quota exceeded'],
    [452, '452 4.5.3 Too many recipients'],
    [451, '451 4.3.0 Local error in processing'],
  ]) {
    const c = R.classifySmtpError({ responseCode: code, response: text });
    assert.equal(c.kind, 'retry', text);
    assert.equal(c.relayWide, false, text);
    assert.equal(c.retryable, true, text);
  }
  assert.equal(R.classifySmtpError({ responseCode: 403, response: 'odd' }).reason, 'smtp_403');
});

test('errors: a 5xx is final', () => {
  const c = R.classifySmtpError({ code: 'EENVELOPE', responseCode: 550, response: '550 5.1.1 User unknown' });
  assert.equal(c.kind, 'permanent');
  assert.equal(c.retryable, false);
  assert.equal(c.relayWide, false);
  assert.equal(c.reason, 'smtp_550_5.1.1');
});

test('errors: rate wording without any code is a throttle; nothing recognisable retries', () => {
  assert.equal(R.classifySmtpError(new Error('throttled by upstream')).kind, 'throttle');
  assert.equal(R.classifySmtpError(new Error('throttled by upstream')).reason, 'rate_text');
  const unknown = R.classifySmtpError(new Error('attachment could not be read'));
  assert.equal(unknown.kind, 'retry');
  assert.equal(unknown.reason, 'unknown');
  assert.equal(R.classifySmtpError('a bare string').kind, 'retry');
  assert.equal(R.classifySmtpError(null).kind, 'retry');
  assert.equal(R.classifySmtpError({ code: 'EMESSAGE' }).reason, 'EMESSAGE');
  // An out-of-range responseCode is ignored rather than trusted.
  assert.equal(R.classifySmtpError({ responseCode: 999, message: 'x' }).kind, 'retry');
});

test('errors: a refusal before the message is about the session, whatever its code', () => {
  // nodemailer's real shapes: a relay blocking our IP at the greeting, and a
  // sender the account may not use at MAIL FROM. Both fail every message.
  const greeting = R.classifySmtpError(
    Object.assign(new Error('Invalid greeting. response=554 5.7.1 blocked: 554 5.7.1 blocked'), {
      code: 'EPROTOCOL',
      command: 'CONN',
      responseCode: 554,
      response: '554 5.7.1 blocked',
    }),
  );
  assert.equal(greeting.kind, 'relay');
  assert.equal(greeting.relayWide, true);
  assert.equal(greeting.retryable, true);
  assert.equal(greeting.reason, 'smtp_554_5.7.1@CONN');
  const sender = R.classifySmtpError({
    code: 'EENVELOPE',
    command: 'MAIL FROM',
    responseCode: 553,
    response: '553 5.7.1 Sender address rejected: not owned by user',
  });
  assert.equal(sender.kind, 'relay');
  assert.equal(sender.reason, 'smtp_553_5.7.1@MAIL_FROM');
  for (const command of ['EHLO', 'HELO', 'LHLO', 'STARTTLS', 'RSET', 'AUTH PLAIN', 'auth login']) {
    assert.equal(R.classifySmtpError({ code: 'EPROTOCOL', command, responseCode: 502, response: '502 no' }).kind, 'relay', command);
  }
  // A non-throttle 4xx at the session stage is relay-wide too; a throttle stays a throttle.
  assert.equal(R.classifySmtpError({ command: 'MAIL FROM', responseCode: 452, response: '452 4.3.1 Insufficient storage' }).kind, 'relay');
  assert.equal(R.classifySmtpError({ command: 'MAIL FROM', responseCode: 450, response: '450 4.7.1 too much mail' }).kind, 'throttle');
  assert.equal(R.classifySmtpError({ command: 'CONN', responseCode: 421, response: '421 4.7.0 try later' }).kind, 'throttle');
  // After MAIL FROM the reply is about this message again.
  assert.equal(R.classifySmtpError({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550 5.1.1 User unknown' }).kind, 'permanent');
  assert.equal(R.classifySmtpError({ code: 'EMESSAGE', command: 'DATA', responseCode: 450, response: '450 4.2.1 busy' }).kind, 'retry');
});

test('errors: a 4.7.x policy refusal at RCPT TO or DATA is about that message, not the relay', () => {
  // One recipient's policy refusal must not pause every lane (#2944).
  const rcpt = R.classifySmtpError({
    code: 'EENVELOPE',
    command: 'RCPT TO',
    responseCode: 450,
    response: '450 4.7.1 <x@example.test>: Recipient address rejected: policy',
  });
  assert.equal(rcpt.kind, 'retry');
  assert.equal(rcpt.relayWide, false);
  assert.equal(R.classifySmtpError({ command: 'DATA', responseCode: 451, response: '451 4.7.0 content policy' }).kind, 'retry');
  // Rate wording or a 421 there is still the relay talking.
  assert.equal(R.classifySmtpError({ command: 'RCPT TO', responseCode: 450, response: '450 4.7.1 Error: too much mail' }).kind, 'throttle');
  assert.equal(R.classifySmtpError({ command: 'DATA', responseCode: 421, response: '421 4.7.0 try later' }).kind, 'throttle');
  // With no command known, a 4.7.x stays relay-wide (the production throttle above).
  assert.equal(R.classifySmtpError({ responseCode: 451, response: '451 4.7.0 Temporary policy' }).kind, 'throttle');
});

test('errors: what nodemailer refuses itself, with no reply, is final', () => {
  for (const [code, command, message] of [
    ['EMESSAGE', 'MAIL FROM', 'Message size larger than allowed 10485760'],
    ['EMESSAGE', 'API', 'Empty message'],
    ['EENVELOPE', 'API', 'No recipients defined'],
    ['EENVELOPE', 'API', 'Invalid recipient "x"'],
    ['EREQUIRETLS', 'MAIL FROM', 'REQUIRETLS can only be used over TLS connections (RFC 8689)'],
  ]) {
    const c = R.classifySmtpError(Object.assign(new Error(message), { code, command }));
    assert.equal(c.kind, 'permanent', `${code} ${message}`);
    assert.equal(c.retryable, false);
    assert.equal(c.relayWide, false);
    assert.equal(c.reason, code);
  }
});

// ── Backoff ──────────────────────────────────────────────────────────────────

test('backoff: exponential, capped per lane, never zero', () => {
  const lo = () => 0;
  const hi = () => 1;
  assert.equal(R.retryDelayMs(1, 'CRITICAL', lo), 7_500);
  assert.equal(R.retryDelayMs(1, 'CRITICAL', hi), 15_000);
  assert.equal(R.retryDelayMs(2, 'CRITICAL', hi), 30_000);
  assert.equal(R.retryDelayMs(50, 'CRITICAL', hi), 5 * 60_000, 'capped');
  assert.equal(R.retryDelayMs(1, 'TRANSACTIONAL', hi), 30_000);
  assert.equal(R.retryDelayMs(99, 'TRANSACTIONAL', hi), 15 * 60_000);
  assert.equal(R.retryDelayMs(1, 'BULK', hi), 120_000);
  assert.equal(R.retryDelayMs(99, 'BULK', lo), 30 * 60_000);
  assert.equal(R.retryDelayMs(0, 'BULK', hi), 120_000, 'attempt < 1 reads as the first');
  assert.equal(R.retryDelayMs(1, 'BULK', () => 7), 120_000, 'random clamped');
  const d = R.retryDelayMs(3, 'TRANSACTIONAL');
  assert.ok(d >= 60_000 && d <= 120_000);
});

// ── Budget config ────────────────────────────────────────────────────────────

test('config: conservative defaults when unset', () => {
  const c = R.budgetConfig({});
  assert.equal(c.ratePerMin, 2);
  assert.equal(c.burst, 2);
  assert.equal(c.urgentReserve, 1);
  assert.equal(c.intervalMs, 30_000);
  assert.equal(c.mode, 'observe');
  assert.deepEqual([...c.ladderSec], [60, 120, 300, 900, 1800]);
});

test('config: values are read, clamped, and a typo never lifts the limit', () => {
  const c = R.budgetConfig({ MAIL_RATE_PER_MIN: '5', MAIL_BURST: '2', MAIL_URGENT_RESERVE: '1', MAIL_METER_MODE: ' OFF ' });
  assert.equal(c.ratePerMin, 5);
  assert.equal(c.intervalMs, 12_000);
  assert.equal(c.mode, 'off');
  assert.equal(R.budgetConfig({ MAIL_RATE_PER_MIN: 'lots' }).ratePerMin, 2);
  assert.equal(R.budgetConfig({ MAIL_RATE_PER_MIN: '  ' }).ratePerMin, 2);
  assert.equal(R.budgetConfig({ MAIL_RATE_PER_MIN: '0' }).ratePerMin, 1);
  assert.equal(R.budgetConfig({ MAIL_RATE_PER_MIN: '100000' }).ratePerMin, 600);
  assert.equal(R.budgetConfig({ MAIL_BURST: '1', MAIL_URGENT_RESERVE: '5' }).urgentReserve, 1, 'reserve ≤ burst');
  assert.equal(R.budgetConfig({ MAIL_METER_MODE: 'enforce' }).mode, 'enforce', 'the queue drain enforces');
  assert.equal(R.budgetConfig({ MAIL_METER_MODE: ' Enforce ' }).mode, 'enforce');
  assert.equal(R.budgetConfig({ MAIL_METER_MODE: 'enforcing' }).mode, 'observe', 'a typo observes');
  assert.equal(R.budgetConfig({ MAIL_RATE_PER_MIN: '7' }).intervalMs, 8572, 'interval rounds up');
});

test('config: each SMTP channel has its own row and may have its own numbers', () => {
  assert.equal(R.budgetNameFor('primary'), 'smtp');
  assert.equal(R.budgetNameFor('bulk'), 'smtp:bulk');
  const env = { MAIL_RATE_PER_MIN: '5', MAIL_BURST: '2', MAIL_URGENT_RESERVE: '1', MAIL_METER_MODE: 'off' };
  // Unset bulk values fall back to the primary ones.
  assert.deepEqual(R.budgetConfig(env, 'bulk'), R.budgetConfig(env, 'primary'));
  const both = { ...env, MAIL_BULK_RATE_PER_MIN: '20', MAIL_BULK_BURST: ' ', MAIL_BULK_URGENT_RESERVE: '0' };
  const bulk = R.budgetConfig(both, 'bulk');
  assert.equal(bulk.ratePerMin, 20);
  assert.equal(bulk.burst, 2, 'blank falls back');
  assert.equal(bulk.urgentReserve, 0);
  assert.equal(bulk.mode, 'off', 'the mode is shared');
  assert.equal(R.budgetConfig(both, 'primary').ratePerMin, 5, 'bulk values never leak into the primary budget');
  assert.equal(R.budgetConfig(both).ratePerMin, 5, 'primary is the default channel');
});

test('config: the pause ladder parses, drops junk and falls back', () => {
  assert.deepEqual([...R.parseLadder('10, 20 ,x,-5,0,30')], [10, 20, 30]);
  assert.deepEqual([...R.parseLadder('999999')], [86400]);
  assert.deepEqual([...R.parseLadder('x,y')], [...R.DEFAULT_LADDER_SEC]);
  assert.deepEqual([...R.parseLadder('')], [...R.DEFAULT_LADDER_SEC]);
  assert.deepEqual([...R.parseLadder(undefined)], [...R.DEFAULT_LADDER_SEC]);
  assert.deepEqual([...R.budgetConfig({ MAIL_THROTTLE_LADDER_SEC: '5,6' }).ladderSec], [5, 6]);
});

// ── GCRA ─────────────────────────────────────────────────────────────────────

const prod = R.budgetConfig({ MAIL_RATE_PER_MIN: '5', MAIL_BURST: '2', MAIL_URGENT_RESERVE: '1' });

test('gcra: tolerance per lane keeps the reserve for CRITICAL', () => {
  assert.equal(R.laneToleranceMs('CRITICAL', prod), 12_000);
  assert.equal(R.laneToleranceMs('TRANSACTIONAL', prod), 0);
  assert.equal(R.laneToleranceMs('BULK', prod), 0);
  const topic = R.budgetConfig({ MAIL_RATE_PER_MIN: '1', MAIL_BURST: '1', MAIL_URGENT_RESERVE: '1' });
  assert.equal(R.laneToleranceMs('CRITICAL', topic), 0);
  assert.equal(R.laneToleranceMs('BULK', topic), -60_000, 'negative: waiting lanes leave an interval idle');
});

/** Simulate a sequence of send attempts against one meter. */
function run(cfg, attempts) {
  let tat = 0;
  return attempts.map(([at, lane]) => {
    const d = R.gcraSpend(tat, at, lane, cfg);
    if (d.allowed) tat = d.tatMs;
    return d;
  });
}

test('gcra: a bulk burst gets one token, then one per interval', () => {
  const t0 = 1_000_000;
  const out = run(prod, [[t0, 'BULK'], [t0, 'BULK'], [t0 + 11_999, 'BULK'], [t0 + 12_000, 'BULK']]);
  assert.deepEqual(out.map((d) => d.allowed), [true, false, false, true]);
  assert.equal(out[1].waitMs, 12_000);
  assert.equal(out[2].waitMs, 1);
  assert.equal(out[0].waitMs, 0);
});

test('gcra: the reserve is there for CRITICAL right after a bulk burst', () => {
  const t0 = 1_000_000;
  const out = run(prod, [[t0, 'BULK'], [t0, 'BULK'], [t0, 'CRITICAL'], [t0, 'CRITICAL']]);
  assert.deepEqual(out.map((d) => d.allowed), [true, false, true, false]);
});

test('gcra: a full burst is C tokens for CRITICAL; the worst minute is about R + C − 1', () => {
  const t0 = 5_000_000;
  const burst = run(prod, [[t0, 'CRITICAL'], [t0, 'CRITICAL'], [t0, 'CRITICAL']]);
  assert.deepEqual(burst.map((d) => d.allowed), [true, true, false]);
  // Hammer the meter every 100 ms for a minute with CRITICAL mail.
  const attempts = [];
  for (let t = 0; t < 60_000; t += 100) attempts.push([t0 + t, 'CRITICAL']);
  const sent = run(prod, attempts).filter((d) => d.allowed).length;
  assert.ok(sent <= prod.ratePerMin + prod.burst - 1, `sent ${sent}`);
  assert.ok(sent >= prod.ratePerMin, `sent ${sent}`);
});

test('gcra: an idle meter does not bank more than the burst', () => {
  const t0 = 10_000_000;
  const out = run(prod, [[0, 'CRITICAL'], [t0, 'CRITICAL'], [t0, 'CRITICAL'], [t0, 'CRITICAL']]);
  assert.deepEqual(out.map((d) => d.allowed), [true, true, true, false]);
});

// ── Pause ladder ─────────────────────────────────────────────────────────────

test('ladder: a throttle pauses by the current rung and climbs one', () => {
  const now = 1_000_000;
  let s = { tatMs: now, level: 0 };
  const pauses = [];
  for (let i = 0; i < 7; i++) {
    s = R.applyThrottle(s.tatMs, now, s.level);
    pauses.push(s.tatMs - now);
  }
  assert.deepEqual(pauses, [60_000, 120_000, 300_000, 900_000, 1_800_000, 1_800_000, 1_800_000]);
  assert.equal(s.level, 4, 'capped at the top rung');
});

test('ladder: a pause never pulls tat backwards', () => {
  const now = 1_000;
  const far = now + 10 * 60_000;
  assert.equal(R.applyThrottle(far, now, 0).tatMs, far);
});

test('ladder: decay walks one rung down and stops at zero', () => {
  assert.equal(R.decayPauseLevel(3), 2);
  assert.equal(R.decayPauseLevel(0), 0);
  assert.equal(R.decayPauseLevel(-2), 0);
});

test('ladder: pauseSeconds clamps the level and survives an empty ladder', () => {
  assert.equal(R.pauseSeconds(-1), 60);
  assert.equal(R.pauseSeconds(99), 1800);
  assert.equal(R.pauseSeconds(1, [5, 6]), 6);
  assert.equal(R.pauseSeconds(0, []), 60);
  assert.deepEqual(R.applyThrottle(0, 0, 0, []), { tatMs: 60_000, level: 1 });
});

// ── Identity and de-duplication ──────────────────────────────────────────────

test('recipient hash: normalised, hex, no address', () => {
  const a = R.recipientHash('  Person@Example.COM ');
  assert.equal(a, R.recipientHash('person@example.com'));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('dedupe: natural keys', () => {
  assert.equal(R.dedupeKeyFor({ kind: 'reset', tokenId: 'ck123' }), 'reset:ck123');
  assert.equal(R.dedupeKeyFor({ kind: 'meeting-reminder', meetingId: 'm1', userId: 'u1' }), 'mrem:m1:u1');
  assert.equal(R.dedupeKeyFor({ kind: 'digest', digest: 'unread', userId: 'u1', day: '2026-10-15' }), 'digest:unread:u1:2026-10-15');
  assert.equal(
    R.dedupeKeyFor({ kind: 'ops', alert: 'email-health', at: new Date('2026-10-15T09:31:02Z') }),
    'ops:email-health:2026-10-15T09',
  );
  const nl = R.dedupeKeyFor({ kind: 'newsletter', newsletterId: 'n1', recipient: 'Reader@Example.com' });
  assert.match(nl, /^nl:n1:[0-9a-f]{32}$/);
  assert.ok(!nl.toLowerCase().includes('example'));
  assert.equal(nl, R.dedupeKeyFor({ kind: 'newsletter', newsletterId: 'n1', recipient: 'reader@example.com' }));
});

test('dedupe: a key part outside the safe alphabet is refused', () => {
  assert.throws(() => R.dedupeKeyFor({ kind: 'reset', tokenId: 'a:b' }), /key part/);
  assert.throws(() => R.dedupeKeyFor({ kind: 'reset', tokenId: '' }), /key part/);
  assert.throws(() => R.dedupeKeyFor({ kind: 'meeting-reminder', meetingId: 'x'.repeat(49), userId: 'u' }), /key part/);
});

test('dedupe: fallback is one key per mail per minute, or per caller reference', () => {
  const base = { kind: 'fallback', category: 'message', to: 'a@example.com', subject: 'Hi' };
  const k1 = R.dedupeKeyFor({ ...base, at: new Date('2026-10-15T09:30:01Z') });
  const k2 = R.dedupeKeyFor({ ...base, to: 'A@example.com', at: new Date('2026-10-15T09:30:59Z') });
  const k3 = R.dedupeKeyFor({ ...base, at: new Date('2026-10-15T09:31:00Z') });
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  assert.match(k1, /^mail:[0-9a-f]{64}$/);
  const r1 = R.dedupeKeyFor({ ...base, ref: 'msg-1', at: new Date('2026-10-15T09:30:01Z') });
  const r2 = R.dedupeKeyFor({ ...base, ref: 'msg-1', at: new Date('2026-10-16T09:30:01Z') });
  assert.equal(r1, r2);
  assert.notEqual(r1, k1);
  assert.notEqual(R.dedupeKeyFor({ ...base, category: undefined, at: new Date(0) }), R.dedupeKeyFor({ ...base, at: new Date(0) }));
});

test('dedupe: every key fits Job.idempotencyKey (191)', () => {
  const long = 'x'.repeat(48);
  for (const k of [
    R.dedupeKeyFor({ kind: 'digest', digest: long, userId: long, day: long }),
    R.dedupeKeyFor({ kind: 'meeting-reminder', meetingId: long, userId: long }),
    R.dedupeKeyFor({ kind: 'fallback', to: 'a@b.c', subject: 's'.repeat(5000), at: new Date() }),
  ]) {
    assert.ok(k.length <= 191, `${k.length}`);
  }
});

// ── Addresses nobody reads (#2970) ──────────────────────────────────────────

test('unmailable: a stand-in lead address and an erased account are refused, with the reason', async () => {
  const { leadStandInEmail } = await import('../../src/lib/marketingImport.ts');
  assert.equal(R.unmailableRecipient(leadStandInEmail('lena@acme-sales.example.test', 'org-1')), 'placeholder_address');
  assert.equal(R.unmailableRecipient('mentee.someone.1a2b@import.local'), 'placeholder_address');
  assert.equal(R.unmailableRecipient('erased-abc@erased.local'), 'erased_address');
  // Case, spaces, a display name and a trailing root dot do not slip past it.
  assert.equal(R.unmailableRecipient('  Lead@IMPORT.LOCAL '), 'placeholder_address');
  assert.equal(R.unmailableRecipient('Lead Person <lead@import.local>'), 'placeholder_address');
  assert.equal(R.unmailableRecipient('lead@import.local.'), 'placeholder_address');
  // A list with one generated address on it is one refused mail.
  assert.equal(R.unmailableRecipient('rep@acme-sales.example.test, lead@import.local'), 'placeholder_address');
});

test('unmailable: real addresses, look-alikes and junk are left alone', () => {
  for (const to of [
    'lead@acme-sales.example.test',
    'someone@import.local.example.test',
    'someone@notimport.local',
    'import.local@acme-sales.example.test',
    'constructor@constructor',
    'someone@constructor',
    'no-at-sign',
    '',
  ]) {
    assert.equal(R.unmailableRecipient(to), null, to);
  }
  assert.equal(R.unmailableRecipient(null), null);
  assert.equal(R.unmailableRecipient(undefined), null);
});
