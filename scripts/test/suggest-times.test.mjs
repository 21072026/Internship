import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { suggestTimes, insideWorkday } = await import('../../src/lib/suggestTimes.ts');

const at = (iso) => new Date(iso);
// Wednesday 2026-10-14; the mentor posts 09:00–12:00 in Berlin (CEST, UTC+2).
const WED = { id: 's', weekday: 3, startTime: '09:00', endTime: '12:00' };
const base = { slots: [WED], mentorZone: 'Europe/Berlin', attendeeZones: ['Europe/Berlin'], busy: [], from: at('2026-10-13T00:00:00Z'), weeks: 0, durationMinutes: 60 };

test('soonest first, sliced to the meeting length, minus everyone busy', () => {
  const r = suggestTimes(base);
  assert.equal(r.reason, null);
  assert.deepEqual(r.suggestions.map((s) => s.startISO), ['2026-10-14T07:00:00.000Z', '2026-10-14T08:00:00.000Z', '2026-10-14T09:00:00.000Z']);
  // The mentee is busy 10:00–10:30 Berlin: that hour goes.
  const busy = [{ start: at('2026-10-14T08:00:00Z'), end: at('2026-10-14T08:30:00Z') }];
  assert.deepEqual(suggestTimes({ ...base, busy }).suggestions.map((s) => s.startISO), ['2026-10-14T07:00:00.000Z', '2026-10-14T09:00:00.000Z']);
});

test('an on-the-hour start beats a half-past one that is only a little sooner', () => {
  const r = suggestTimes({ ...base, durationMinutes: 30, busy: [{ start: at('2026-10-14T07:00:00Z'), end: at('2026-10-14T07:30:00Z') }] });
  // 09:30 is free and soonest, but 10:00 ranks first; 09:30 still comes before 10:30.
  assert.deepEqual(r.suggestions.slice(0, 3).map((s) => s.startISO), ['2026-10-14T08:00:00.000Z', '2026-10-14T07:30:00.000Z', '2026-10-14T09:00:00.000Z']);
});

test('working hours bind on every clock: 09:00 Berlin is 03:00 in New York — not a suggestion', () => {
  const r = suggestTimes({ ...base, attendeeZones: ['Europe/Berlin', 'America/New_York'] });
  assert.deepEqual(r, { suggestions: [], reason: 'outside_hours' });
  // Istanbul is an hour ahead of Berlin: all three stay inside its day.
  assert.equal(suggestTimes({ ...base, attendeeZones: ['Europe/Berlin', 'Europe/Istanbul'] }).suggestions.length, 3);
  // A meeting ending 20:00 sharp is inside the day; one ending 20:30 is not.
  assert.equal(insideWorkday(at('2026-10-14T17:00:00Z'), at('2026-10-14T18:00:00Z'), 'Europe/Berlin'), true);
  assert.equal(insideWorkday(at('2026-10-14T17:30:00Z'), at('2026-10-14T18:30:00Z'), 'Europe/Berlin'), false);
});

test('across the DST change the wall clock holds and the working-hours check follows it', () => {
  // Wednesday 21 Oct (CEST) and 28 Oct (CET): 09:00 Berlin is 07:00Z, then 08:00Z.
  const r = suggestTimes({ ...base, from: at('2026-10-20T00:00:00Z'), weeks: 1, durationMinutes: 180 });
  assert.deepEqual(r.suggestions.map((s) => s.startISO), ['2026-10-21T07:00:00.000Z', '2026-10-28T08:00:00.000Z']);
  // New York leaves summer time a week after Berlin (1 Nov), so the gap is 6 h
  // on 21 Oct and 5 h on 28 Oct: the first New York-friendly hour moves with it.
  const nyc = suggestTimes({ ...base, slots: [{ ...WED, startTime: '14:00', endTime: '17:00' }], from: at('2026-10-20T00:00:00Z'), weeks: 1, attendeeZones: ['Europe/Berlin', 'America/New_York'] });
  // 14:00 Berlin = 08:00 NY on 21 Oct (6 h) and 09:00 NY on 28 Oct (5 h).
  assert.deepEqual(nyc.suggestions.map((s) => s.startISO).slice(0, 2), ['2026-10-21T12:00:00.000Z', '2026-10-21T13:00:00.000Z']);
  assert.ok(nyc.suggestions.some((s) => s.startISO === '2026-10-28T13:00:00.000Z'));
});

test('the empty state names the binding constraint', () => {
  assert.equal(suggestTimes({ ...base, slots: [] }).reason, 'no_hours');
  assert.equal(suggestTimes({ ...base, busy: [{ start: at('2026-10-14T00:00:00Z'), end: at('2026-10-15T00:00:00Z') }] }).reason, 'all_taken');
  // Inside the notice horizon counts as "no hours" — none are on offer at all.
  assert.equal(suggestTimes({ ...base, from: at('2026-10-14T06:00:00Z'), minNoticeMinutes: 24 * 60 }).reason, 'no_hours');
});
