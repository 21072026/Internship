// Unit tests for the .ics builders (#2015). Pure node — no browser, no DB.
//
// The interesting part is the METHOD/SEQUENCE pair: a calendar client removes an
// event it already stored only when the file says METHOD:CANCEL *and* carries a
// SEQUENCE higher than the one it kept. Getting that wrong leaves a ghost
// meeting in everyone's calendar for ever, and reading the string by hand is the
// only way to catch it before a real client does.
import { test, expect } from '@playwright/test';
import { buildMeetingIcs, buildFeedIcs } from '@/lib/ics';

const START = new Date('2026-09-10T09:00:00Z');

test('defaults are unchanged: PUBLISH, sequence 0, 30 minutes', () => {
  const ics = buildMeetingIcs({ uid: 'm1', title: 'Weekly 1:1', start: START });
  expect(ics).toContain('METHOD:PUBLISH');
  expect(ics).toContain('SEQUENCE:0');
  expect(ics).toContain('DTSTART:20260910T090000Z');
  expect(ics).toContain('DTEND:20260910T093000Z');
  expect(ics).toContain('UID:m1@crm.ersah.in');
  expect(ics).not.toContain('STATUS:CANCELLED');
});

test('an invitation is a REQUEST', () => {
  const ics = buildMeetingIcs({
    uid: 'm1',
    title: 'Weekly 1:1',
    start: START,
    method: 'REQUEST',
    location: 'https://meet.jit.si/x',
  });
  expect(ics).toContain('METHOD:REQUEST');
  expect(ics).toContain('LOCATION:https://meet.jit.si/x');
});

test('a cancellation carries CANCEL, CANCELLED and the bumped sequence', () => {
  const ics = buildMeetingIcs({ uid: 'm1', title: 'Weekly 1:1', start: START, method: 'CANCEL', sequence: 2 });
  expect(ics).toContain('METHOD:CANCEL');
  expect(ics).toContain('STATUS:CANCELLED');
  expect(ics).toContain('SEQUENCE:2');
  // Same UID as the invitation above — that is what tells the client *which*
  // event to drop.
  expect(ics).toContain('UID:m1@crm.ersah.in');
});

test('durationMinutes drives DTEND', () => {
  const ics = buildMeetingIcs({ uid: 'm1', title: 'Long one', start: START, durationMinutes: 90 });
  expect(ics).toContain('DTEND:20260910T103000Z');
});

test('the subscription feed stays title-and-time only', () => {
  const ics = buildFeedIcs('InternshipCRM', [
    { uid: 'series-s1-2026-09-10T09:00:00.000Z', title: 'Project call', start: START },
    { uid: 'deadline-r1', title: '100 · First contact', start: START },
  ]);
  expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  expect(ics).toContain('UID:series-s1-2026-09-10T09:00:00.000Z@crm.ersah.in');
  expect(ics).toContain('UID:deadline-r1@crm.ersah.in');
  // The invariant the feed's privacy promise rests on.
  expect(ics).not.toContain('DESCRIPTION');
  expect(ics).not.toContain('LOCATION');
  expect(ics).not.toContain('https://');
});
