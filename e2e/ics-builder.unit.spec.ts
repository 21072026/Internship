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

test('an invitation is a REQUEST with an organizer and an attendee', () => {
  const ics = buildMeetingIcs({
    uid: 'm1',
    title: 'Weekly 1:1',
    start: START,
    method: 'REQUEST',
    location: 'https://meet.jit.si/x',
    organizer: { email: 'noreply@crm.ersah.in', name: 'Internship CRM' },
    attendee: { email: 'mentee@example.com', name: 'Ada Lovelace' },
  });
  expect(ics).toContain('METHOD:REQUEST');
  expect(ics).toContain('LOCATION:https://meet.jit.si/x');
  // Without these two an iTIP REQUEST is not a meeting request: Gmail renders no
  // invitation card and Outlook rejects it (RFC 5546 §3.2.2).
  expect(ics).toContain('ORGANIZER;CN="Internship CRM":mailto:noreply@crm.ersah.in');
  expect(ics).toContain(
    'ATTENDEE;CN="Ada Lovelace";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:mentee@example.com'
  );
});

test('a nameless participant simply has no CN', () => {
  const ics = buildMeetingIcs({
    uid: 'm1',
    title: 'Weekly 1:1',
    start: START,
    method: 'REQUEST',
    organizer: { email: 'noreply@crm.ersah.in' },
    attendee: { email: 'guest@example.com', name: '  ' },
  });
  expect(ics).toContain('ORGANIZER:mailto:noreply@crm.ersah.in');
  expect(ics).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:guest@example.com');
});

test('a PUBLISH copy stays participant-free', () => {
  const ics = buildMeetingIcs({
    uid: 'm1',
    title: 'Weekly 1:1',
    start: START,
    organizer: { email: 'noreply@crm.ersah.in' },
    attendee: { email: 'mentee@example.com' },
  });
  // The public token route hands out a read-only copy; nothing negotiates, and
  // no address may ride along in it.
  expect(ics).not.toContain('ORGANIZER');
  expect(ics).not.toContain('ATTENDEE');
  expect(ics).not.toContain('mentee@example.com');
});

test('a cancellation carries CANCEL, CANCELLED and the bumped sequence', () => {
  const ics = buildMeetingIcs({
    uid: 'm1',
    title: 'Weekly 1:1',
    start: START,
    method: 'CANCEL',
    sequence: 2,
    organizer: { email: 'noreply@crm.ersah.in', name: 'Internship CRM' },
    attendee: { email: 'mentee@example.com' },
  });
  expect(ics).toContain('METHOD:CANCEL');
  expect(ics).toContain('STATUS:CANCELLED');
  expect(ics).toContain('SEQUENCE:2');
  // Same UID as the invitation above — that, *together with* the ORGANIZER, is
  // what tells the client which event to drop. Outlook and Google match a
  // cancellation on both, so a CANCEL without an organizer is silently ignored
  // and the meeting stays in the calendar.
  expect(ics).toContain('UID:m1@crm.ersah.in');
  expect(ics).toContain('ORGANIZER;CN="Internship CRM":mailto:noreply@crm.ersah.in');
  // No RSVP on a cancellation: nothing is being asked.
  expect(ics).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:mentee@example.com');
  expect(ics).not.toContain('RSVP=TRUE');
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
