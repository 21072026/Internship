// Unit tests for expanding a mentor's recurring weekly availability into the
// concrete date-times a mentee can pick (#1361). Pure node — no browser, no DB.
//
// The interesting cases are all about zones: a slot is a wall clock in the
// MENTOR's zone, so expanding it must resolve in that zone and stay correct
// across a DST transition. Getting that wrong is invisible in a same-zone test
// and wrong by an hour twice a year in production, which is exactly the kind of
// bug that gets reported as "the mentee booked the wrong time".
import { test, expect } from '@playwright/test';
import { expandSlots, matchesSlot, type WeeklySlot } from '@/lib/availabilitySlots';

const MON_9 : WeeklySlot = { id: 'a', weekday: 1, startTime: '09:00', endTime: '10:00' };
const WED_14: WeeklySlot = { id: 'b', weekday: 3, startTime: '14:00', endTime: '15:30' };

test('no slots expands to nothing', () => {
  expect(expandSlots([], 'Europe/Istanbul', { from: new Date('2026-08-25T00:00:00Z') })).toEqual([]);
});

test('a weekly slot yields one occurrence per week, soonest first', () => {
  // Tuesday 2026-08-25, so the next Monday is 2026-08-31.
  const out = expandSlots([MON_9], 'Europe/Istanbul', {
    from: new Date('2026-08-25T00:00:00Z'),
    weeks: 3,
  });
  expect(out.map((o) => o.date)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14']);
  expect(out.every((o) => o.startTime === '09:00' && o.weekday === 1)).toBe(true);
  // Istanbul is UTC+3 year-round: 09:00 local is 06:00Z.
  expect(out[0].startISO).toBe('2026-08-31T06:00:00.000Z');
});

test('occurrences already past are dropped, later ones on the same day are not', () => {
  // Monday 2026-08-31 at 12:00 Istanbul — that morning's 09:00 is gone, but a
  // 14:00 slot the same day is still on offer.
  const MON_14: WeeklySlot = { id: 'c', weekday: 1, startTime: '14:00', endTime: '15:00' };
  const out = expandSlots([MON_9, MON_14], 'Europe/Istanbul', {
    from: new Date('2026-08-31T09:00:00Z'), // 12:00 Istanbul
    weeks: 1,
  });
  expect(out[0]).toMatchObject({ date: '2026-08-31', startTime: '14:00' });
  expect(out.some((o) => o.date === '2026-08-31' && o.startTime === '09:00')).toBe(false);
});

test('the wall clock survives a DST transition rather than sliding an hour', () => {
  // Europe/Berlin leaves summer time on 2026-10-25. A Monday 09:00 slot must
  // stay 09:00 local on both sides — the INSTANT moves, the clock does not.
  const out = expandSlots([MON_9], 'Europe/Berlin', {
    from: new Date('2026-10-18T00:00:00Z'),
    weeks: 3,
  });
  const before = out.find((o) => o.date === '2026-10-19')!;
  const after = out.find((o) => o.date === '2026-10-26')!;
  expect(before.startISO).toBe('2026-10-19T07:00:00.000Z'); // CEST, UTC+2
  expect(after.startISO).toBe('2026-10-26T08:00:00.000Z'); // CET, UTC+1
  expect(before.startTime).toBe(after.startTime);
});

test('the mentor zone decides the weekday, not the viewer zone', () => {
  // 2026-08-31T21:00Z is Monday in Istanbul (Tuesday 00:00 is 3h later) but
  // already Tuesday in Auckland. Expanding a Monday slot in Pacific/Auckland
  // must not offer that instant as a Monday.
  const out = expandSlots([MON_9], 'Pacific/Auckland', {
    from: new Date('2026-08-25T00:00:00Z'),
    weeks: 1,
  });
  expect(out).toHaveLength(1);
  expect(out[0].date).toBe('2026-08-31');
  // NZST in August is UTC+12, so 09:00 local is 21:00Z the day before.
  expect(out[0].startISO).toBe('2026-08-30T21:00:00.000Z');
});

test('several slots interleave in chronological order and the limit is honoured', () => {
  const out = expandSlots([MON_9, WED_14], 'Europe/Istanbul', {
    from: new Date('2026-08-25T00:00:00Z'),
    weeks: 4,
    limit: 5,
  });
  expect(out).toHaveLength(5);
  const sorted = [...out].map((o) => o.startISO).sort();
  expect(out.map((o) => o.startISO)).toEqual(sorted);
  // Wednesday 2026-08-26 comes before Monday 2026-08-31.
  expect(out[0].date).toBe('2026-08-26');
});

test('matchesSlot recognises an instant inside a slot and rejects its edges', () => {
  const inside = new Date('2026-08-31T06:30:00Z'); // Mon 09:30 Istanbul
  expect(matchesSlot(inside, [MON_9], 'Europe/Istanbul')?.id).toBe('a');

  // The slot is half-open: its own start counts, its end does not.
  expect(matchesSlot(new Date('2026-08-31T06:00:00Z'), [MON_9], 'Europe/Istanbul')?.id).toBe('a');
  expect(matchesSlot(new Date('2026-08-31T07:00:00Z'), [MON_9], 'Europe/Istanbul')).toBeNull();

  // Right clock, wrong day.
  expect(matchesSlot(new Date('2026-09-01T06:30:00Z'), [MON_9], 'Europe/Istanbul')).toBeNull();
  // Right instant, but read in a zone where it is not Monday 09:30.
  expect(matchesSlot(inside, [MON_9], 'Pacific/Auckland')).toBeNull();
});

// ── One-offs and away windows (#2001) ──────────────────────────────────────

test('a one-off slot is offered exactly once, on its date, whatever its weekday field says', () => {
  // Thursday 2026-09-03; the stored weekday is deliberately wrong to prove the date wins.
  const ONCE: WeeklySlot = { id: 'o', weekday: 0, startTime: '11:00', endTime: '12:00', date: '2026-09-03T00:00:00.000Z' };
  const out = expandSlots([ONCE, MON_9], 'Europe/Istanbul', { from: new Date('2026-08-25T00:00:00Z'), weeks: 3 });
  const onces = out.filter((o) => o.slotId === 'o');
  expect(onces.map((o) => o.date)).toEqual(['2026-09-03']);
  expect(onces[0].startISO).toBe('2026-09-03T08:00:00.000Z');
  // A past one-off is simply not offered.
  expect(expandSlots([ONCE], 'Europe/Istanbul', { from: new Date('2026-09-04T00:00:00Z') })).toEqual([]);
  // …and matchesSlot claims it only on its own date.
  expect(matchesSlot(new Date('2026-09-03T08:30:00Z'), [ONCE], 'Europe/Istanbul')?.id).toBe('o');
  expect(matchesSlot(new Date('2026-09-10T08:30:00Z'), [ONCE], 'Europe/Istanbul')).toBeNull();
});

test('an away window removes every occurrence on its dates, both ends inclusive', () => {
  const out = expandSlots([MON_9, WED_14], 'Europe/Istanbul', {
    from: new Date('2026-08-25T00:00:00Z'),
    weeks: 3,
    exceptions: [{ startDate: '2026-08-31', endDate: '2026-09-07' }],
  });
  // Mon 31 Aug (first day) and Mon 7 Sep (last day) are gone, Wed 2 Sep in between too.
  expect(out.map((o) => o.date)).toEqual(['2026-08-26', '2026-09-09', '2026-09-14', '2026-09-16']);
});

test('away dates are read in the MENTOR zone, across a DST change', () => {
  // New York, Sunday 23:30 — already Monday in UTC. Europe and the US both
  // leave summer time around here (EU 25 Oct, US 1 Nov 2026).
  const SUN_LATE: WeeklySlot = { id: 's', weekday: 0, startTime: '23:30', endTime: '23:59' };
  const from = new Date('2026-10-20T00:00:00Z');
  const all = expandSlots([SUN_LATE], 'America/New_York', { from, weeks: 3 });
  expect(all.map((o) => o.date)).toEqual(['2026-10-25', '2026-11-01', '2026-11-08']);
  // EDT (UTC−4) before the change, EST (UTC−5) after: the wall clock holds.
  expect(all[0].startISO).toBe('2026-10-26T03:30:00.000Z');
  expect(all[1].startISO).toBe('2026-11-02T04:30:00.000Z');
  // Away on Sunday 1 Nov in New York — the day of the change — removes the
  // occurrence although its UTC instant falls on Monday 2 Nov.
  const away = expandSlots([SUN_LATE], 'America/New_York', { from, weeks: 3, exceptions: [{ startDate: '2026-11-01', endDate: '2026-11-01' }] });
  expect(away.map((o) => o.date)).toEqual(['2026-10-25', '2026-11-08']);
  // An away window on the UTC date (Mon 2 Nov) leaves the Sunday slot alone.
  const utcDay = expandSlots([SUN_LATE], 'America/New_York', { from, weeks: 3, exceptions: [{ startDate: '2026-11-02', endDate: '2026-11-02' }] });
  expect(utcDay).toHaveLength(3);
});
