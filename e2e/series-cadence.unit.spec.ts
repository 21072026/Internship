// A standing 1:1's cadence through the real, zone-aware expansion (#2013). The
// pure week/end arithmetic is unit-tested in scripts/test/series-rule.test.mjs;
// this pins what that arithmetic is FOR: a biweekly 09:30 Berlin meeting stays
// at 09:30 Berlin, every other Monday, across the 2026-10-25 DST change.
// Pure node, no browser — run with BASE_URL=http://localhost:9 to skip the webServer.
import { test, expect } from '@playwright/test';
import { ruleOccurrences, nextRuleOccurrence } from '@/lib/meetingSeriesOccurrences';

const berlin = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

const rule = {
  daysOfWeek: [1],
  timeOfDay: '09:30',
  timeZone: 'Europe/Berlin',
  intervalWeeks: 2,
  anchorDate: new Date('2026-10-12T00:00:00Z'),
};

test('biweekly 09:30 Berlin stays 09:30 Berlin across the October DST change', () => {
  const got = ruleOccurrences(rule, new Date('2026-10-01T00:00:00Z'), new Date('2026-11-30T00:00:00Z'));
  expect(got.map(berlin).map((s) => s.replace(/,/g, ''))).toEqual(['Mon 12/10 09:30', 'Mon 26/10 09:30', 'Mon 09/11 09:30', 'Mon 23/11 09:30']);
  // The UTC instant moves by an hour at the change; the wall clock does not.
  expect(got.map((d) => d.toISOString().slice(11, 16))).toEqual(['07:30', '08:30', '08:30', '08:30']);
});

test('the end condition stops the expansion and the "next" lookup', () => {
  const capped = { ...rule, maxOccurrences: 2 };
  expect(ruleOccurrences(capped, new Date('2026-10-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'))).toHaveLength(2);
  expect(nextRuleOccurrence(capped, new Date('2026-10-27T00:00:00Z'))).toBeNull();
  // A 4-weekly rule's next meeting is found even three weeks out (the window widens).
  const monthly = { ...rule, intervalWeeks: 4 };
  expect(nextRuleOccurrence(monthly, new Date('2026-10-13T00:00:00Z'))?.toISOString()).toBe('2026-11-09T08:30:00.000Z');
});

test('a rule without a cadence is weekly and endless, exactly as before #2013', () => {
  const weekly = { daysOfWeek: [1], timeOfDay: '09:30', timeZone: 'Europe/Berlin' };
  expect(ruleOccurrences(weekly, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T00:00:00Z'))).toHaveLength(4);
});
