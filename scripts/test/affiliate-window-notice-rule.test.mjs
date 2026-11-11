// Unit tests for the partner's window notice (src/lib/affiliateWindowNoticeRule.ts,
// docs/affiliate-module.md "Window notice", #3556).
//
// Run: npm run test:unit
//
// Every plan here is SYNTHETIC — currency XTS (ISO 4217's code reserved for
// testing) and numbers that resemble no real contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerWindowEndsAt, evaluatePartner } from '../../src/lib/affiliateCommissionRule.ts';
import {
  WINDOW_NOTICE_DAYS_DEFAULT,
  WINDOW_NOTICE_DAYS_MAX,
  dueWindowNotices,
  parseWindowNoticeDays,
  planHasWindow,
  readWindowNoticeDays,
  windowNoticeDue,
} from '../../src/lib/affiliateWindowNoticeRule.ts';

const PLAN = Object.freeze({
  currency: 'XTS',
  tiers: [{ upToMinor: 1_000, commissionMinor: 300 }],
  topCommissionMinor: 700,
  percentBps: 1_500,
  switchAtCustomer: 2,
  boundaryCustomer: 'PERCENT',
  windowMonths: 6,
  payoutDays: 10,
  afterNotice: 'RUN_OUT',
});
const plan = (over = {}) => ({ ...PLAN, ...over });

const DAY = 24 * 60 * 60 * 1000;
const iso = (d) => d.toISOString().slice(0, 10);
const pay = (id, customerId, when, amountMinor = 500, currency = 'XTS') => ({ id, customerId, amountMinor, currency, receivedAt: new Date(when) });
const ACTIVE = { noticeEffectiveAt: null };

test('the window end is the first payment plus windowMonths, clamped to the month end', () => {
  assert.equal(iso(customerWindowEndsAt(plan({ windowMonths: 1 }), new Date('2026-01-31T10:00:00Z'))), '2026-02-28');
  assert.equal(iso(customerWindowEndsAt(plan({ windowMonths: 1 }), new Date('2028-01-31T10:00:00Z'))), '2028-02-29');
  assert.equal(iso(customerWindowEndsAt(plan({ windowMonths: 24 }), new Date('2026-03-10T00:00:00Z'))), '2028-03-10');
});

test('no window limit means no end and no notice', () => {
  assert.equal(customerWindowEndsAt(plan({ windowMonths: null }), new Date('2026-01-31T10:00:00Z')), null);
  assert.equal(planHasWindow(plan({ windowMonths: null })), false);
  assert.equal(planHasWindow(plan({ percentBps: 0 })), false);
  assert.equal(planHasWindow(plan()), true);
});

test('the engine reads the same function for the window it stores', () => {
  const ev = evaluatePartner(plan(), ACTIVE, [pay('p1', 'c1', '2026-01-31T10:00:00Z'), pay('p2', 'c2', '2026-02-01T10:00:00Z')]);
  assert.equal(iso(ev.payments[0].windowEndsAt), iso(customerWindowEndsAt(plan(), new Date('2026-01-31T10:00:00Z'))));
});

test('lead time: whole days 0…180, a stored value out of range reads as the default', () => {
  assert.equal(WINDOW_NOTICE_DAYS_DEFAULT, 30);
  for (const ok of [0, 1, 30, WINDOW_NOTICE_DAYS_MAX, '45']) assert.equal(parseWindowNoticeDays(ok), Number(ok), String(ok));
  for (const bad of [-1, 181, 1.5, '', ' ', 'x', null, undefined, {}, NaN]) assert.equal(parseWindowNoticeDays(bad), null, String(bad));
  assert.equal(readWindowNoticeDays(undefined), 30);
  assert.equal(readWindowNoticeDays(999), 30);
  assert.equal(readWindowNoticeDays(0), 0);
});

test('a notice is due only for an end in (now, now + lead], never twice, never when off', () => {
  const now = new Date('2026-06-01T05:00:00Z');
  const in10 = new Date(now.getTime() + 10 * DAY);
  assert.equal(windowNoticeDue({ endsAt: in10, now, leadDays: 30, sentAt: null }), true);
  assert.equal(windowNoticeDue({ endsAt: new Date(now.getTime() + 30 * DAY), now, leadDays: 30, sentAt: null }), true);
  assert.equal(windowNoticeDue({ endsAt: new Date(now.getTime() + 30 * DAY + 1), now, leadDays: 30, sentAt: null }), false, 'too early');
  assert.equal(windowNoticeDue({ endsAt: now, now, leadDays: 30, sentAt: null }), false, 'ends now');
  assert.equal(windowNoticeDue({ endsAt: new Date(now.getTime() - DAY), now, leadDays: 30, sentAt: null }), false, 'already ended');
  assert.equal(windowNoticeDue({ endsAt: in10, now, leadDays: 30, sentAt: new Date('2026-05-30T05:00:00Z') }), false, 'already sent');
  assert.equal(windowNoticeDue({ endsAt: in10, now, leadDays: 0, sentAt: null }), false, 'turned off');
  assert.equal(windowNoticeDue({ endsAt: null, now, leadDays: 30, sentAt: null }), false, 'no window');
});

// c1 first paid 2025-12-15, c2 (the switch customer) 2026-01-05, c3 2026-03-01.
// With windowMonths 6: c1 ends 2026-06-15, c2 2026-07-05, c3 2026-09-01.
const HISTORY = [
  pay('p1', 'c1', '2025-12-15T08:00:00Z'),
  pay('p2', 'c2', '2026-01-05T08:00:00Z'),
  pay('p3', 'c3', '2026-03-01T08:00:00Z'),
  pay('p4', 'c1', '2026-02-15T08:00:00Z'),
];
const customers = (sent = {}) => ['c1', 'c2', 'c3'].map((id) => ({ id, windowNoticeSentAt: sent[id] ?? null }));
const due = (over = {}) => {
  const p = over.plan ?? plan();
  const partner = over.partner ?? ACTIVE;
  const payments = over.payments ?? HISTORY;
  return dueWindowNotices({
    plan: p,
    partner,
    evaluation: evaluatePartner(p, partner, payments),
    customers: over.customers ?? customers(),
    now: new Date(over.now ?? '2026-06-01T05:00:00Z'),
    leadDays: over.leadDays ?? 30,
  });
};
const ids = (list) => list.map((d) => `${d.customerId}@${iso(d.endsAt)}`);

test('the customers whose window ends within the lead time, soonest first', () => {
  assert.deepEqual(ids(due()), ['c1@2026-06-15']);
  assert.deepEqual(ids(due({ leadDays: 40 })), ['c1@2026-06-15', 'c2@2026-07-05']);
  assert.deepEqual(ids(due({ now: '2026-06-20T05:00:00Z' })), ['c2@2026-07-05'], 'c1 has ended: never announced late');
});

test('a customer already told is not told again; the lead time 0 tells nobody', () => {
  assert.deepEqual(ids(due({ customers: customers({ c1: new Date('2026-05-20T05:00:00Z') }) })), []);
  assert.deepEqual(ids(due({ leadDays: 0 })), []);
});

test('nothing to announce before the percent phase, without one, or without a window limit', () => {
  assert.deepEqual(ids(due({ payments: [pay('p1', 'c1', '2025-12-15T08:00:00Z')] })), [], 'one customer: the switch at no. 2 is not reached');
  assert.deepEqual(ids(due({ plan: plan({ percentBps: 0 }) })), []);
  assert.deepEqual(ids(due({ plan: plan({ windowMonths: null }) })), []);
});

test('the date is the first VALID payment: a zero or foreign-currency payment does not start the window', () => {
  const payments = [pay('p0', 'c1', '2025-11-01T08:00:00Z', 0), pay('px', 'c1', '2025-11-02T08:00:00Z', 500, 'XXX'), ...HISTORY];
  assert.deepEqual(ids(due({ payments })), ['c1@2026-06-15']);
});

test('a terminated partner: RUN_OUT keeps the notice, STOP_ALL drops windows the termination ends first', () => {
  const partner = { noticeEffectiveAt: new Date('2026-06-10T00:00:00Z') };
  assert.deepEqual(ids(due({ partner, leadDays: 40 })), ['c1@2026-06-15', 'c2@2026-07-05']);
  assert.deepEqual(ids(due({ partner, leadDays: 40, plan: plan({ afterNotice: 'STOP_ALL' }) })), []);
  const later = { noticeEffectiveAt: new Date('2026-06-20T00:00:00Z') };
  assert.deepEqual(ids(due({ partner: later, leadDays: 40, plan: plan({ afterNotice: 'STOP_ALL' }) })), ['c1@2026-06-15']);
});

test('a customer that first paid after the termination counts for nothing and is never announced', () => {
  const partner = { noticeEffectiveAt: new Date('2026-02-01T00:00:00Z') };
  const payments = [...HISTORY, pay('p5', 'c4', '2026-02-20T08:00:00Z')];
  const list = due({ partner, payments, leadDays: 200, now: '2026-06-01T05:00:00Z', customers: [...customers(), { id: 'c4', windowNoticeSentAt: null }] });
  assert.ok(!ids(list).some((x) => x.startsWith('c4@')), ids(list).join());
  assert.ok(!ids(list).some((x) => x.startsWith('c3@')), 'c3 first paid after the termination too');
});
