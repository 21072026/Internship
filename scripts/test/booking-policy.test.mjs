import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { checkPolicy, periodBounds, widenForBuffer, isEmptyPolicy } = await import('../../src/lib/bookingPolicyRule.ts');
const { expandSlots, sliceWindow } = await import('../../src/lib/availabilitySlots.ts');

const NONE = { minNoticeMinutes: null, bufferMinutes: null, maxPerWeek: null, maxPerMonth: null, defaultSlotMinutes: null };
const at = (iso) => new Date(iso);
const base = (over = {}) => ({ start: at('2026-10-14T09:00:00Z'), end: at('2026-10-14T10:00:00Z'), now: at('2026-10-14T06:00:00Z'), timezone: 'UTC', weekCount: 0, monthCount: 0, busy: [], ...over });

test('a week starts Monday 00:00 and a month on the 1st — in the mentor zone, not UTC', () => {
  // Sunday 2026-10-18 23:30 in Berlin is Sunday; in UTC it is still Sunday 21:30.
  const w = periodBounds(at('2026-10-18T21:30:00Z'), 'Europe/Berlin', 'week');
  assert.equal(w.start.toISOString(), '2026-10-11T22:00:00.000Z'); // Mon 12 Oct 00:00 CEST
  assert.equal(w.end.toISOString(), '2026-10-18T22:00:00.000Z');
  // Monday 00:30 in Istanbul is still Sunday in UTC — it belongs to the NEW week.
  const ist = periodBounds(at('2026-10-18T21:30:00Z'), 'Europe/Istanbul', 'week');
  assert.equal(ist.start.toISOString(), '2026-10-18T21:00:00.000Z');
  // A week across the EU clock change (25 Oct) is 169 hours long, not 168.
  const dst = periodBounds(at('2026-10-21T12:00:00Z'), 'Europe/Berlin', 'week');
  assert.equal((dst.end - dst.start) / 3_600_000, 169);
  // December rolls into the next year.
  const dec = periodBounds(at('2026-12-31T23:30:00Z'), 'Europe/Berlin', 'month');
  assert.equal(dec.start.toISOString(), '2026-12-31T23:00:00.000Z'); // 1 Jan 00:00 CET
});

test('rules in order: notice, buffer, week, month — the first one broken is named', () => {
  assert.equal(checkPolicy(null, base()), null);
  assert.equal(checkPolicy(NONE, base()), null);
  assert.ok(isEmptyPolicy(NONE));
  const notice = checkPolicy({ ...NONE, minNoticeMinutes: 240 }, base({ now: at('2026-10-14T06:30:00Z') }));
  assert.deepEqual(notice && [notice.rule, notice.limit], ['min_notice', 240]);
  assert.equal(checkPolicy({ ...NONE, minNoticeMinutes: 180 }, base()), null); // exactly 3 h ahead is fine

  const busy = [{ start: at('2026-10-14T10:10:00Z'), end: at('2026-10-14T11:00:00Z') }];
  const buffer = checkPolicy({ ...NONE, bufferMinutes: 15 }, base({ busy }));
  assert.deepEqual(buffer && [buffer.rule, buffer.windowStart], ['buffer', '2026-10-14T10:10:00.000Z']);
  assert.equal(checkPolicy({ ...NONE, bufferMinutes: 10 }, base({ busy })), null); // 10 min gap = enough

  const week = checkPolicy({ ...NONE, maxPerWeek: 3, maxPerMonth: 3 }, base({ weekCount: 3, monthCount: 3 }));
  assert.deepEqual(week && [week.rule, week.windowStart], ['weekly_cap', '2026-10-12T00:00:00.000Z']);
  const month = checkPolicy({ ...NONE, maxPerWeek: 3, maxPerMonth: 8 }, base({ weekCount: 1, monthCount: 8 }));
  assert.deepEqual(month && [month.rule, month.windowStart], ['monthly_cap', '2026-10-01T00:00:00.000Z']);
  assert.equal(checkPolicy({ ...NONE, maxPerWeek: 3 }, base({ weekCount: 2 })), null);
});

test('a 09:00–12:00 window at 30 minutes is six blocks; a trailing part block is not offered', () => {
  assert.deepEqual(sliceWindow('09:00', '12:00', 30).map(([a]) => a), ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  assert.deepEqual(sliceWindow('09:00', '10:15', 30), [['09:00', '09:30'], ['09:30', '10:00']]);
  const slot = { id: 's', weekday: 3, startTime: '09:00', endTime: '12:00' };
  const out = expandSlots([slot], 'UTC', { from: at('2026-10-13T00:00:00Z'), weeks: 0, slotMinutes: 30 });
  assert.equal(out.length, 6);
  assert.equal(out[1].startISO, '2026-10-14T09:30:00.000Z');
  assert.equal(out[1].minutes, 30);
  // A window's own length beats the default.
  assert.equal(expandSlots([{ ...slot, slotMinutes: 60 }], 'UTC', { from: at('2026-10-13T00:00:00Z'), weeks: 0, slotMinutes: 30 }).length, 3);
});

test('blocks inside the notice horizon, or touching a buffered meeting, are not offered', () => {
  const slot = { id: 's', weekday: 3, startTime: '09:00', endTime: '12:00' };
  // At 06:00 with 4 hours' notice, nothing before 10:00 is on offer.
  const out = expandSlots([slot], 'UTC', { from: at('2026-10-14T06:00:00Z'), weeks: 0, slotMinutes: 60, minNoticeMinutes: 240 });
  assert.deepEqual(out.map((o) => o.startTime), ['11:00']); // 10:00 is exactly the horizon — not after it
  const widened = widenForBuffer([{ start: at('2026-10-14T10:00:00Z'), end: at('2026-10-14T10:30:00Z') }], 15);
  assert.equal(widened[0].start.toISOString(), '2026-10-14T09:45:00.000Z');
  assert.equal(widened[0].end.toISOString(), '2026-10-14T10:45:00.000Z');
  assert.equal(widenForBuffer(widened, 0), widened);
});
