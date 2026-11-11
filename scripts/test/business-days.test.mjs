// Business-day SLA arithmetic (#1638): prisma/business-days.mjs, the one
// implementation the request path, the admin SLA save and the backfill share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBusinessDays,
  slaDeadline,
  parseWorkingDays,
  parseHolidayList,
  DEFAULT_WORKING_DAYS,
} from '../../prisma/business-days.mjs';

const BERLIN = 'Europe/Berlin';
const IST = 'Europe/Istanbul';
const rule = (over = {}) => ({ workingDays: DEFAULT_WORKING_DAYS, holidays: [], timeZone: BERLIN, ...over });
const local = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(d);

test('3 business days from Thursday 17:00 is Tuesday 17:00, not Sunday', () => {
  // Thursday 2026-10-15 17:00 Berlin (CEST, UTC+2).
  const from = new Date('2026-10-15T15:00:00Z');
  const due = addBusinessDays(from, 3, rule());
  assert.equal(local(due, BERLIN), '2026-10-20, 17:00');
  assert.equal(new Date(due).getUTCDay(), 2);
});

test('calendar mode is exactly from + days × 24h (unchanged behaviour)', () => {
  const from = new Date('2026-10-15T15:00:00Z');
  for (const r of [null, undefined, { mode: 'calendar', timeZone: BERLIN }]) {
    assert.equal(slaDeadline(from, 3, r).getTime(), from.getTime() + 3 * 86400000);
  }
});

test('a public holiday extends the deadline once', () => {
  const from = new Date('2026-10-15T15:00:00Z'); // Thu
  // Monday 19 Oct off: Fri, Tue, Wed.
  const due = addBusinessDays(from, 3, rule({ holidays: ['2026-10-19'] }));
  assert.equal(local(due, BERLIN), '2026-10-21, 17:00');
});

test('a holiday on a Saturday does not extend the deadline at all', () => {
  const from = new Date('2026-10-15T15:00:00Z');
  const plain = addBusinessDays(from, 3, rule());
  const withSat = addBusinessDays(from, 3, rule({ holidays: ['2026-10-17'] }));
  assert.equal(withSat.getTime(), plain.getTime());
});

test('a run of consecutive holidays is skipped as a block', () => {
  // Christmas week 2026: Thu 24 Dec … Fri 1 Jan off, from Wed 23 Dec 09:00.
  const from = new Date('2026-12-23T08:00:00Z');
  const holidays = ['2026-12-24', '2026-12-25', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01'];
  const due = addBusinessDays(from, 2, rule({ holidays }));
  // Working days after Wed 23: Mon 4 Jan (1), Tue 5 Jan (2).
  assert.equal(local(due, BERLIN), '2027-01-05, 09:00');
});

test('the wall-clock time survives a DST change (Berlin, end of October)', () => {
  // Fri 23 Oct 2026 10:00 CEST (UTC+2); clocks go back Sun 25 Oct.
  const from = new Date('2026-10-23T08:00:00Z');
  const due = addBusinessDays(from, 1, rule());
  assert.equal(local(due, BERLIN), '2026-10-26, 10:00');
  assert.equal(due.toISOString(), '2026-10-26T09:00:00.000Z'); // CET, UTC+1
  // …and into summer time (29 Mar 2026).
  const spring = addBusinessDays(new Date('2026-03-27T09:00:00Z'), 1, rule()); // Fri 10:00 CET
  assert.equal(local(spring, BERLIN), '2026-03-30, 10:00');
  assert.equal(spring.toISOString(), '2026-03-30T08:00:00.000Z');
});

test('the weekday is judged in the scope zone, not on UTC', () => {
  // Fri 22:30 UTC is already Saturday 01:30 in Istanbul.
  const from = new Date('2026-10-16T22:30:00Z');
  const due = addBusinessDays(from, 1, rule({ timeZone: IST }));
  assert.equal(local(due, IST), '2026-10-19, 01:30'); // Monday
});

test('custom working days (Sunday–Thursday) are honoured', () => {
  const from = new Date('2026-10-15T15:00:00Z'); // Thu
  const due = addBusinessDays(from, 1, rule({ workingDays: [0, 1, 2, 3, 4] }));
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: BERLIN, weekday: 'short' }).format(due), 'Sun');
});

test('zero days returns the start; an empty rule falls back to Mon–Fri', () => {
  const from = new Date('2026-10-15T15:00:00Z');
  assert.equal(addBusinessDays(from, 0, rule()).getTime(), from.getTime());
  assert.equal(addBusinessDays(from, 3, rule({ workingDays: [] })).getTime(), addBusinessDays(from, 3, rule()).getTime());
});

test('parseWorkingDays and parseHolidayList', () => {
  assert.deepEqual(parseWorkingDays('5, 1,3,3'), [1, 3, 5]);
  assert.deepEqual(parseWorkingDays('nonsense'), [1, 2, 3, 4, 5]);
  const { holidays, invalidLines } = parseHolidayList('# DE 2026\n2026-10-03, Tag der Deutschen Einheit\n2026-12-25;Christmas\n2026-02-30, nope\nfoo\n2026-10-03, dup\n2026-12-26');
  assert.deepEqual(holidays, [
    { date: '2026-10-03', label: 'Tag der Deutschen Einheit' },
    { date: '2026-12-25', label: 'Christmas' },
    { date: '2026-12-26', label: '2026-12-26' },
  ]);
  assert.deepEqual(invalidLines, [4, 5]);
});
