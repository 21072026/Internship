// Unit tests for the admin's partner funnel board — badges, the commission-window
// warning, the org total and the sort allowlist (src/lib/affiliateFunnelBoardRule.ts,
// docs/affiliate-module.md § The funnel, #3544). Synthetic ids and dates only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// affiliateFunnelBoardRule.ts imports its siblings without an extension; see ts-extensionless-resolve.mjs.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { funnelBadges, funnelRates, funnelTotal, windowEndingSoon, parseFunnelBoardQuery, sortFunnelRows, MANY_CLICKS } = await import(
  '../../src/lib/affiliateFunnelBoardRule.ts'
);

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-15T12:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY);
// A first payment whose 24-month window ends `inDays` days from NOW.
const windowEndsIn = (inDays) => new Date(Date.UTC(2024, 5, 15, 12) + inDays * DAY);
const funnel = (over = {}) => ({ clicks: 0, uniqueClicks: 0, registrations: 0, freePeriod: 0, neverPaid: 0, paying: 0, active: 0, passive: 0, ...over });

test('badge: many clicks and no registration — strictly more than the threshold', () => {
  const row = { clicks: MANY_CLICKS + 1, registrations: 0, paying: 0, passive: 0, windowEndingSoon: 0 };
  assert.deepEqual(funnelBadges(row), ['CLICKS_NO_SIGNUPS']);
  assert.deepEqual(funnelBadges({ ...row, clicks: MANY_CLICKS }), []);
  assert.deepEqual(funnelBadges({ ...row, registrations: 1 }), []);
});

test('badge: most paying customers passive — more than half, from three paying customers on', () => {
  const row = { clicks: 0, registrations: 5, paying: 4, passive: 3, windowEndingSoon: 0 };
  assert.deepEqual(funnelBadges(row), ['MOSTLY_PASSIVE']);
  assert.deepEqual(funnelBadges({ ...row, passive: 2 }), []); // exactly half is not most
  assert.deepEqual(funnelBadges({ ...row, paying: 2, passive: 2 }), []); // too few to say
});

test('badge: a window ending soon; badges combine in a fixed order', () => {
  assert.deepEqual(funnelBadges({ clicks: 500, registrations: 0, paying: 0, passive: 0, windowEndingSoon: 2 }), ['CLICKS_NO_SIGNUPS', 'WINDOW_ENDING']);
});

test('window: active customers of a switched partner whose window ends within 30 days', () => {
  const base = {
    now: NOW,
    windowMonths: 24,
    afterNotice: 'RUN_OUT',
    noticeEffectiveAt: null,
    switched: true,
    customers: [
      { status: 'ACTIVE', firstValidPaymentAt: windowEndsIn(10) }, // counted
      { status: 'ACTIVE', firstValidPaymentAt: windowEndsIn(30) }, // the 30th day still counts
      { status: 'ACTIVE', firstValidPaymentAt: windowEndsIn(31) }, // not yet
      { status: 'ACTIVE', firstValidPaymentAt: windowEndsIn(-1) }, // already closed
      { status: 'PASSIVE', firstValidPaymentAt: windowEndsIn(5) }, // no longer paying
      { status: 'FREE_PERIOD', firstValidPaymentAt: null },
    ],
  };
  assert.equal(windowEndingSoon(base), 2);
  assert.equal(windowEndingSoon({ ...base, switched: false }), 0);
  assert.equal(windowEndingSoon({ ...base, windowMonths: null }), 0);
  // STOP_ALL after a termination in effect: nothing accrues, no warning; RUN_OUT keeps it.
  assert.equal(windowEndingSoon({ ...base, afterNotice: 'STOP_ALL', noticeEffectiveAt: ago(1) }), 0);
  assert.equal(windowEndingSoon({ ...base, noticeEffectiveAt: ago(1) }), 2);
  // A customer first paid at or after the termination has no ordinal in the engine.
  assert.equal(windowEndingSoon({ ...base, noticeEffectiveAt: windowEndsIn(20) }), 1);
});

test('rates follow the portal card: clicks → registrations, registrations → paying, whole %', () => {
  assert.deepEqual(funnelRates(funnel({ clicks: 20, registrations: 4, paying: 3 })), { registrationRate: 20, payingRate: 75 });
  assert.deepEqual(funnelRates(funnel()), { registrationRate: null, payingRate: null });
});

test('the org total sums every step', () => {
  const total = funnelTotal([funnel({ clicks: 5, registrations: 2, paying: 1, active: 1 }), funnel({ clicks: 7, uniqueClicks: 3, passive: 2, paying: 2 })]);
  assert.deepEqual(total, funnel({ clicks: 12, uniqueClicks: 3, registrations: 2, paying: 3, active: 1, passive: 2 }));
});

test('the query: allowlisted values only, defaults when absent', () => {
  const q = (s) => parseFunnelBoardQuery(new URLSearchParams(s));
  assert.deepEqual(q(''), { ok: true, query: { period: 'month', sort: 'clicks', dir: 'desc', page: 1 } });
  assert.deepEqual(q('period=all&sort=payingRate&dir=asc&page=2'), { ok: true, query: { period: 'all', sort: 'payingRate', dir: 'asc', page: 2 } });
  assert.deepEqual(q('sort=displayName'), { ok: false, field: 'sort' });
  assert.deepEqual(q('sort=__proto__'), { ok: false, field: 'sort' });
  assert.deepEqual(q('period=30d'), { ok: false, field: 'period' });
  assert.deepEqual(q('dir=up'), { ok: false, field: 'dir' });
  assert.deepEqual(q('page=0'), { ok: false, field: 'page' });
  assert.deepEqual(q('page=1e3'), { ok: false, field: 'page' });
});

test('sorting: direction, nulls last both ways, id tiebreak', () => {
  const row = (partnerId, displayName, clicks, payingRate) => ({ partnerId, displayName, clicks, payingRate });
  const rows = [row('c', 'Gamma', 5, null), row('a', 'alpha', 5, 50), row('b', 'Beta', 9, 10)];
  const ids = (sort, dir) => sortFunnelRows(rows, sort, dir).map((r) => r.partnerId);
  assert.deepEqual(ids('clicks', 'desc'), ['b', 'a', 'c']);
  assert.deepEqual(ids('clicks', 'asc'), ['a', 'c', 'b']);
  assert.deepEqual(ids('payingRate', 'desc'), ['a', 'b', 'c']);
  assert.deepEqual(ids('payingRate', 'asc'), ['b', 'a', 'c']);
  assert.deepEqual(ids('partner', 'asc'), ['a', 'b', 'c']);
});
