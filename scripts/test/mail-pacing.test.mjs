// Unit tests for pacing transactional and bulk mail through the queue (#2951):
// the lane routing, the drain's claim bands and world alternation, the daily
// cap, the estimate an admin is shown and the natural keys of the time-bound
// senders.
//
// Run: npm run test:unit   (node --test --experimental-strip-types)
//
// What is pinned here, and why each matters:
//   ROUTING   — MAIL_QUEUE_LANES moves TRANSACTIONAL/BULK to the queue and
//               never CRITICAL; a bulk invitation run drops to TRANSACTIONAL
//               and can never climb back to the reserve.
//   BANDS     — every queued mail is reachable: the higher lanes' band and the
//               bulk band partition the priorities, and the claim filter's
//               in-memory twin agrees with the SQL's rule.
//   FAIRNESS  — the BULK drain alternates between the two worlds, so a long
//               campaign in one product cannot starve the other's digests.
//   DAILY CAP — bulk stops at 90 % of MAIL_DAILY_CAP; the higher lanes are
//               counted but never stopped; yesterday's count is today's zero.
//   ESTIMATE  — the "delivered over about X" an admin reads.
//   KEYS      — a moved meeting is reminded again, a guest key carries no
//               address, an ops alert is one per window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const R = await import('../../src/lib/mailDeliveryRule.ts');
const W = await import('../../src/lib/mailWorkerRule.ts');
const Q = await import('../../src/lib/jobs/queue.ts');
const T = await import('../../src/lib/mailQueueNoticeText.ts');

// ── Routing ─────────────────────────────────────────────────────────────────

test('routing: MAIL_QUEUE_LANES names TRANSACTIONAL and BULK, never CRITICAL', () => {
  const p = W.mailPolicy({ MAIL_QUEUE_LANES: 'transactional, BULK ,critical,nonsense' });
  assert.deepEqual([...p.queueLanes].sort(), ['BULK', 'TRANSACTIONAL']);
  assert.equal(W.mailPolicy({}).queueLanes.size, 0, 'unset = PR 2 behaviour: nothing queued outright');
  assert.equal(W.mailPolicy({ MAIL_QUEUE_LANES: '' }).queueLanes.size, 0, 'empty is the rollback');
});

test('routing: which lane each kind of mass mail rides', () => {
  assert.equal(R.laneFor('announcement'), 'BULK');
  assert.equal(R.laneFor('newsletter'), 'BULK');
  assert.equal(R.laneFor('unread-digest'), 'BULK');
  assert.equal(R.laneFor('survey-invite'), 'BULK');
  assert.equal(R.laneFor('weekly-report'), 'BULK');
  // Time-bound: a meeting reminder is worthless after the start.
  assert.equal(R.laneFor('meeting-reminder'), 'TRANSACTIONAL');
  assert.equal(R.laneFor('meeting-series-reminder'), 'TRANSACTIONAL');
  assert.equal(R.laneFor('meeting-guest-reminder'), 'TRANSACTIONAL');
  // Meeting invites stay transactional (owner decision).
  assert.equal(R.laneFor('meeting-invite'), 'TRANSACTIONAL');
});

test('routing: a bulk invitation run drops to TRANSACTIONAL and cannot climb', () => {
  assert.equal(R.laneFor('invitation'), 'CRITICAL');
  assert.equal(R.effectiveLane('invitation', 'TRANSACTIONAL'), 'TRANSACTIONAL');
  assert.equal(R.effectiveLane('announcement', 'CRITICAL'), 'BULK', 'a lane is a claim on the reserve');
  assert.equal(R.effectiveLane('announcement', 'TRANSACTIONAL'), 'BULK');
  assert.equal(R.effectiveLane('invitation', undefined), 'CRITICAL');
});

// ── Claim bands ─────────────────────────────────────────────────────────────

test('bands: every lane priority falls in exactly one claim band', () => {
  const higher = (p) => p >= R.HIGHER_LANE_MIN_PRIORITY;
  const bulk = (p) => p <= R.HIGHER_LANE_MIN_PRIORITY - 1;
  for (const [lane, cat] of [
    ['CRITICAL', 'verification'],
    ['TRANSACTIONAL', 'message'],
    ['BULK', 'unread-digest'],
    ['BULK', 'newsletter'],
  ]) {
    const p = R.lanePriority(lane, cat);
    assert.equal(higher(p) + bulk(p), 1, `${lane}/${cat}: ${p}`);
    assert.equal(bulk(p), lane === 'BULK', `${lane} in the right band`);
    if (lane === 'BULK') assert.ok(p <= R.BULK_PRIORITY_MAX);
  }
  // A hand-set priority anywhere is still reachable.
  for (let p = -5; p <= 120; p++) assert.equal(higher(p) + bulk(p), 1, String(p));
});

test('bands: the claim filter twin matches priority bounds and one payload field', () => {
  const row = (priority, world) => ({ priority, payload: { world, lane: 'BULK' } });
  assert.equal(Q.matchesClaimFilter(row(20, 'MARKETING')), true);
  assert.equal(Q.matchesClaimFilter(row(20, 'MARKETING'), { minPriority: 50 }), false);
  assert.equal(Q.matchesClaimFilter(row(50, 'MARKETING'), { minPriority: 50 }), true);
  assert.equal(Q.matchesClaimFilter(row(20, 'MARKETING'), { maxPriority: 49 }), true);
  assert.equal(Q.matchesClaimFilter(row(100, 'MARKETING'), { maxPriority: 49 }), false);
  assert.equal(Q.matchesClaimFilter(row(0, 'MARKETING'), { maxPriority: 49, payload: { key: 'world', value: 'MARKETING' } }), true);
  assert.equal(Q.matchesClaimFilter(row(0, 'INTERNSHIP'), { payload: { key: 'world', value: 'MARKETING' } }), false);
  assert.equal(Q.matchesClaimFilter({ priority: 0, payload: null }, { payload: { key: 'world', value: 'MARKETING' } }), false);
  assert.ok(Q.CLAIM_PAYLOAD_KEY.test('world'));
  assert.ok(!Q.CLAIM_PAYLOAD_KEY.test("world') OR 1=1 --"));
  assert.ok(!Q.CLAIM_PAYLOAD_KEY.test('a.b'));
});

test('bands: the in-memory store claims the higher lanes before bulk, by world when asked', async () => {
  const store = Q.createMemoryQueueStore();
  const now = new Date('2026-10-16T09:00:00Z');
  const opts = { store, now: () => now };
  await Q.enqueue('email.send', { lane: 'BULK', world: 'MARKETING' }, { ...opts, priority: 0, runAt: now });
  await Q.enqueue('email.send', { lane: 'BULK', world: 'INTERNSHIP' }, { ...opts, priority: 20, runAt: now });
  await Q.enqueue('email.send', { lane: 'TRANSACTIONAL', world: 'INTERNSHIP' }, { ...opts, priority: 50, runAt: now });

  const higher = await Q.claim('w', { ...opts, names: ['email.send'], filter: { minPriority: 50 } });
  assert.deepEqual(higher.map((r) => r.payload.lane), ['TRANSACTIONAL']);
  const marketing = await Q.claim('w', {
    ...opts,
    names: ['email.send'],
    limit: 1,
    filter: { maxPriority: 49, payload: { key: 'world', value: 'MARKETING' } },
  });
  assert.deepEqual(marketing.map((r) => r.payload.world), ['MARKETING'], 'the lower priority is taken when its world is due');
  const rest = await Q.claim('w', { ...opts, names: ['email.send'], filter: { maxPriority: 49 } });
  assert.deepEqual(rest.map((r) => r.payload.world), ['INTERNSHIP']);
  await assert.rejects(
    Q.claim('w', { ...opts, filter: { payload: { key: 'bad key', value: 'x' } } }),
    /plain identifier/,
  );
});

// ── Fairness between the worlds ─────────────────────────────────────────────

test('fairness: the bulk drain asks for the other world first', () => {
  assert.deepEqual(R.bulkWorldOrder(null), ['INTERNSHIP', 'MARKETING']);
  assert.deepEqual(R.bulkWorldOrder('INTERNSHIP'), ['MARKETING', 'INTERNSHIP']);
  assert.deepEqual(R.bulkWorldOrder('MARKETING'), ['INTERNSHIP', 'MARKETING']);
  assert.deepEqual(R.bulkWorldOrder('SOMETHING-ELSE'), ['INTERNSHIP', 'MARKETING']);
});

test('fairness: two backlogs drain interleaved; one world alone drains on its own', () => {
  // Simulate the drain's choice: the preferred world if it has a row, else any.
  const drain = (queues) => {
    const out = [];
    let last = null;
    while (Object.values(queues).some((q) => q.length)) {
      const [preferred] = R.bulkWorldOrder(last);
      const world = queues[preferred]?.length ? preferred : Object.keys(queues).find((k) => queues[k].length);
      out.push(queues[world].shift());
      last = world;
    }
    return out;
  };
  const both = drain({ INTERNSHIP: ['i1', 'i2', 'i3'], MARKETING: ['m1', 'm2', 'm3', 'm4', 'm5'] });
  assert.deepEqual(both, ['i1', 'm1', 'i2', 'm2', 'i3', 'm3', 'm4', 'm5']);
  assert.deepEqual(drain({ INTERNSHIP: [], MARKETING: ['m1', 'm2'] }), ['m1', 'm2']);
});

// ── The daily cap ───────────────────────────────────────────────────────────

test('daily cap: unset is no cap, and the env is clamped', () => {
  assert.equal(R.budgetConfig({}).dailyCap, 0);
  assert.equal(R.bulkDailyLimit(R.budgetConfig({})), null);
  assert.equal(R.budgetConfig({ MAIL_DAILY_CAP: '2000' }).dailyCap, 2000);
  assert.equal(R.budgetConfig({ MAIL_DAILY_CAP: '-5' }).dailyCap, 0);
  assert.equal(R.budgetConfig({ MAIL_DAILY_CAP: 'lots' }).dailyCap, 0);
  // The bulk channel's own cap, falling back to the shared one.
  assert.equal(R.budgetConfig({ MAIL_DAILY_CAP: '200', MAIL_BULK_DAILY_CAP: '50' }, 'bulk').dailyCap, 50);
  assert.equal(R.budgetConfig({ MAIL_DAILY_CAP: '200' }, 'bulk').dailyCap, 200);
});

test('daily cap: bulk stops at 90 %, the higher lanes are never stopped', () => {
  const cfg = { dailyCap: 2000 };
  assert.equal(R.bulkDailyLimit(cfg), 1800);
  assert.equal(R.bulkDailyLimit({ dailyCap: 1 }), 1, 'a tiny cap still lets one bulk mail through');
  assert.equal(R.bulkDailyLimit({ dailyCap: 50 }), 45);
  const today = '2026-10-16';
  assert.equal(R.dailyCapAllows('BULK', { dayKey: today, dayCount: 1799 }, today, cfg), true);
  assert.equal(R.dailyCapAllows('BULK', { dayKey: today, dayCount: 1800 }, today, cfg), false);
  assert.equal(R.dailyCapAllows('TRANSACTIONAL', { dayKey: today, dayCount: 1999 }, today, cfg), true);
  assert.equal(R.dailyCapAllows('CRITICAL', { dayKey: today, dayCount: 99999 }, today, cfg), true);
  // Yesterday's count is today's zero.
  assert.equal(R.dailyCapAllows('BULK', { dayKey: '2026-10-15', dayCount: 99999 }, today, cfg), true);
  assert.equal(R.dailyCapAllows('BULK', { dayKey: null, dayCount: 0 }, today, cfg), true);
  assert.equal(R.dailyCapAllows('BULK', { dayKey: today, dayCount: 99999 }, today, { dailyCap: 0 }), true);
});

test('daily cap: the counter rolls over at UTC midnight', () => {
  assert.deepEqual(R.countSend({ dayKey: '2026-10-16', dayCount: 4 }, '2026-10-16'), { dayKey: '2026-10-16', dayCount: 5 });
  assert.deepEqual(R.countSend({ dayKey: '2026-10-15', dayCount: 4 }, '2026-10-16'), { dayKey: '2026-10-16', dayCount: 1 });
  assert.deepEqual(R.countSend({ dayKey: null, dayCount: 0 }, '2026-10-16'), { dayKey: '2026-10-16', dayCount: 1 });
  assert.equal(R.utcDayKey(new Date('2026-10-16T23:59:59.999Z')), '2026-10-16');
  assert.equal(R.msUntilNextUtcDay(new Date('2026-10-16T23:59:59.000Z')), 1000);
  assert.equal(R.msUntilNextUtcDay(new Date('2026-10-16T00:00:00.000Z')), 24 * 60 * 60 * 1000);
});

// ── What an admin is told ───────────────────────────────────────────────────

test('estimate: minutes at the configured rate when paced, rough otherwise', () => {
  const enforce = { mode: 'enforce', ratePerMin: 5 };
  assert.equal(R.queueEtaMinutes(0, enforce), 0);
  assert.equal(R.queueEtaMinutes(1, enforce), 1);
  assert.equal(R.queueEtaMinutes(30, enforce), 6);
  assert.equal(R.queueEtaMinutes(31, enforce), 7);
  assert.equal(R.queueEtaMinutes(600, { mode: 'enforce', ratePerMin: 1 }), 600);
  assert.equal(R.queueEtaMinutes(60, { mode: 'observe', ratePerMin: 1 }), Math.ceil(60 / R.UNPACED_SENDS_PER_MIN));
});

test('estimate: the sentence, in minutes under an hour and whole hours above', () => {
  const copy = { queuedNotice: '{n} queued, about {eta}.', minutes: '{n} min', hours: '{n} h' };
  assert.equal(T.mailQueueNoticeText(null, copy), null);
  assert.equal(T.mailQueueNoticeText({ queued: 0, backlog: 0, etaMinutes: 0 }, copy), null);
  assert.equal(T.mailQueueNoticeText({ queued: 30, backlog: 30, etaMinutes: 6 }, copy), '30 queued, about 6 min.');
  assert.equal(T.mailQueueNoticeText({ queued: 200, backlog: 400, etaMinutes: 400 }, copy), '200 queued, about 7 h.');
  assert.equal(T.etaText(0.2, copy), '1 min');
  assert.equal(T.etaText(60, copy), '1 h');
});

// ── Natural keys of the time-bound senders ──────────────────────────────────

test('keys: a meeting reminder is per participant and per start time', () => {
  const at = new Date('2026-10-16T10:00:00Z');
  const k = R.dedupeKeyFor({ kind: 'meeting-reminder', meetingId: 'm1', userId: 'u1', at });
  assert.equal(k, `mrem:m1:u1:${Math.floor(at.getTime() / 60000)}`);
  const moved = R.dedupeKeyFor({ kind: 'meeting-reminder', meetingId: 'm1', userId: 'u1', at: new Date('2026-10-16T11:00:00Z') });
  assert.notEqual(k, moved, 'a moved meeting is reminded again');
  assert.equal(R.dedupeKeyFor({ kind: 'meeting-reminder', meetingId: 'm1', userId: 'u1' }), 'mrem:m1:u1');
  assert.throws(() => R.dedupeKeyFor({ kind: 'meeting-reminder', meetingId: 'm1', userId: 'u1', at: new Date('x') }), /invalid date/);
});

test('keys: a guest reminder carries a hash, never the address', () => {
  const at = new Date('2026-10-16T10:00:00Z');
  const k = R.dedupeKeyFor({ kind: 'guest-reminder', meetingId: 'm1', guest: 'Guest@Example.com', at });
  assert.match(k, /^mgrem:m1:[0-9a-f]{32}:\d+$/);
  assert.ok(!k.toLowerCase().includes('example'));
  assert.equal(k, R.dedupeKeyFor({ kind: 'guest-reminder', meetingId: 'm1', guest: 'guest@example.com', at }));
  assert.match(R.dedupeKeyFor({ kind: 'guest-reminder', meetingId: 'm1', guest: 'g@example.com' }), /^mgrem:m1:[0-9a-f]{32}$/);
});

test('keys: series reminders and survey mails', () => {
  const at = new Date('2026-10-17T09:00:00Z');
  assert.equal(
    R.dedupeKeyFor({ kind: 'series-reminder', seriesId: 's1', userId: 'u1', at, lead: 'DAY_BEFORE' }),
    `srem:s1:u1:${Math.floor(at.getTime() / 60000)}:DAY_BEFORE`,
  );
  assert.notEqual(
    R.dedupeKeyFor({ kind: 'series-reminder', seriesId: 's1', userId: 'u1', at, lead: 'DAY_BEFORE' }),
    R.dedupeKeyFor({ kind: 'series-reminder', seriesId: 's1', userId: 'u1', at, lead: 'HOUR_BEFORE' }),
  );
  assert.equal(R.dedupeKeyFor({ kind: 'survey', invitationId: 'inv1', round: 0 }), 'survey:inv1:0');
  assert.equal(R.dedupeKeyFor({ kind: 'survey', invitationId: 'inv1', round: 2.7 }), 'survey:inv1:2');
  const long = 'x'.repeat(48);
  assert.ok(R.dedupeKeyFor({ kind: 'series-reminder', seriesId: long, userId: long, at, lead: long }).length <= 191);
  assert.ok(R.dedupeKeyFor({ kind: 'guest-reminder', meetingId: long, guest: 'a@b.c', at }).length <= 191);
});

test('keys: an ops alert is one per window, across replicas and restarts', () => {
  const w = (iso, h) => R.opsAlertWindow(new Date(iso), h).toISOString();
  assert.equal(w('2026-10-16T09:31:02Z'), '2026-10-16T09:00:00.000Z');
  assert.equal(w('2026-10-16T09:31:02Z', 6), '2026-10-16T06:00:00.000Z');
  assert.equal(w('2026-10-16T05:59:59Z', 6), '2026-10-16T00:00:00.000Z');
  assert.equal(w('2026-10-16T05:59:59Z', 0), '2026-10-16T05:00:00.000Z', 'clamped to at least an hour');
  assert.equal(w('2026-10-16T05:59:59Z', 99), '2026-10-16T00:00:00.000Z', 'clamped to a day');
  const a = R.dedupeKeyFor({ kind: 'ops', alert: 'email-stale', at: R.opsAlertWindow(new Date('2026-10-16T07:00:00Z'), 6) });
  const b = R.dedupeKeyFor({ kind: 'ops', alert: 'email-stale', at: R.opsAlertWindow(new Date('2026-10-16T11:59:00Z'), 6) });
  const c = R.dedupeKeyFor({ kind: 'ops', alert: 'email-stale', at: R.opsAlertWindow(new Date('2026-10-16T12:00:00Z'), 6) });
  assert.equal(a, b);
  assert.notEqual(b, c);
});
