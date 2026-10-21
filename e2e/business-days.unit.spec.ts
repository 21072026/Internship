import { test, expect } from '@playwright/test';
import { addBusinessDays, parseHolidayList, parseWorkingDays, DEFAULT_WORKING_DAYS } from '@/lib/businessDays';

// #1638 — business-day SLA arithmetic, browserless.

const MON_FRI = new Set(DEFAULT_WORKING_DAYS);
const none = new Set<string>();
const berlin = { workingDays: MON_FRI, holidays: none, timeZone: 'Europe/Berlin' };

test.describe('addBusinessDays', { tag: '@smoke' }, () => {
  test('Thursday 17:00 + 3 business days is the following Tuesday 17:00, not Sunday', () => {
    // 2026-10-15 is a Thursday; 17:00 Berlin = 15:00 UTC (CEST).
    const due = addBusinessDays(new Date('2026-10-15T15:00:00Z'), 3, berlin);
    expect(due.toISOString()).toBe('2026-10-20T15:00:00.000Z');
  });

  test('a holiday on a working day extends the deadline once; one on a Saturday does not', () => {
    const from = new Date('2026-10-15T15:00:00Z'); // Thu
    const monHoliday = addBusinessDays(from, 3, { ...berlin, holidays: new Set(['2026-10-19']) });
    expect(monHoliday.toISOString()).toBe('2026-10-21T15:00:00.000Z');
    const satHoliday = addBusinessDays(from, 3, { ...berlin, holidays: new Set(['2026-10-17']) });
    expect(satHoliday.toISOString()).toBe('2026-10-20T15:00:00.000Z');
  });

  test('a run of consecutive holidays is skipped as a block', () => {
    // Thu 2026-12-24 09:00 Berlin, with 24–26 Dec and 31 Dec / 1 Jan off.
    const from = new Date('2026-12-23T08:00:00Z'); // Wed 09:00 CET
    const due = addBusinessDays(from, 3, {
      ...berlin,
      holidays: new Set(['2026-12-24', '2026-12-25', '2026-12-28', '2026-12-29']),
    });
    // Counted: Wed 30, Thu 31, Fri 1 Jan.
    expect(due.toISOString()).toBe('2027-01-01T08:00:00.000Z');
  });

  test('a DST switch inside the window keeps the wall clock', () => {
    // Fri 2026-10-23 17:00 CEST (15:00Z); clocks go back on Sun 25 Oct.
    const due = addBusinessDays(new Date('2026-10-23T15:00:00Z'), 1, berlin);
    // Mon 26 Oct 17:00 CET = 16:00Z.
    expect(due.toISOString()).toBe('2026-10-26T16:00:00.000Z');
  });

  test('the zone decides the local date, not the server', () => {
    // 23:30 UTC on a Friday is already Saturday in Istanbul.
    const from = new Date('2026-10-16T23:30:00Z');
    const ist = addBusinessDays(from, 1, { ...berlin, timeZone: 'Europe/Istanbul' });
    // Saturday 02:30 local → Monday 02:30 local (Sunday 23:30 UTC).
    expect(ist.toISOString()).toBe('2026-10-18T23:30:00.000Z');
    const ny = addBusinessDays(from, 1, { ...berlin, timeZone: 'America/New_York' });
    // Still Friday 19:30 in New York → Monday 19:30 local.
    expect(ny.toISOString()).toBe('2026-10-19T23:30:00.000Z');
  });

  test('zero days is the start itself', () => {
    const from = new Date('2026-10-15T15:00:00Z');
    expect(addBusinessDays(from, 0, berlin)).toBe(from);
  });
});

test.describe('holiday and working-day parsing', { tag: '@smoke' }, () => {
  test('a pasted list keeps valid dates once and reports the lines it could not read', () => {
    const r = parseHolidayList('2026-12-25, Christmas\n\n2026-02-30, nope\nnot a date\n2026-12-25; again\n2027-01-01\tNew Year');
    expect(r.rows).toEqual([
      { date: '2026-12-25', label: 'Christmas' },
      { date: '2027-01-01', label: 'New Year' },
    ]);
    expect(r.rejected).toEqual([3, 4]);
  });

  test('working days fall back to Monday–Friday when unusable', () => {
    expect([...parseWorkingDays('1,2,3')]).toEqual([1, 2, 3]);
    expect([...parseWorkingDays('')]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseWorkingDays('0,9,x')]).toEqual([1, 2, 3, 4, 5]);
  });
});
