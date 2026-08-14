import { test, expect } from '@playwright/test';
import { getMentorAvailability } from '../src/lib/mentorAvailability';

// #941: pure-function coverage for the shared availability helper. No DB, no
// browser — this only exercises the derivation logic that #941 (mentor
// screen) and #942 (admin assignment screen) will both call.

test('acceptingMentees=false always reports not_accepting, even with capacity to spare', () => {
  const result = getMentorAvailability({ mentorCapacity: 5, activeMenteeCount: 1, acceptingMentees: false });
  expect(result.status).toBe('not_accepting');
  expect(result.source).toBe('preference');
});

test('a defined capacity that has been reached reports at_capacity', () => {
  const result = getMentorAvailability({ mentorCapacity: 3, activeMenteeCount: 3, acceptingMentees: true });
  expect(result.status).toBe('at_capacity');
  expect(result.source).toBe('preference');
  expect(result.capacityKnown).toBe(true);
});

test('accepting with room under capacity reports available', () => {
  const result = getMentorAvailability({ mentorCapacity: 4, activeMenteeCount: 2, acceptingMentees: true });
  expect(result.status).toBe('available');
  expect(result.source).toBe('preference');
});

test('acceptingMentees=null (no preference set) derives the status from capacity alone', () => {
  const full = getMentorAvailability({ mentorCapacity: 2, activeMenteeCount: 2, acceptingMentees: null });
  expect(full.status).toBe('at_capacity');
  expect(full.source).toBe('capacity');

  const open = getMentorAvailability({ mentorCapacity: 2, activeMenteeCount: 0, acceptingMentees: null });
  expect(open.status).toBe('available');
  expect(open.source).toBe('capacity');
});

test('an unset capacity is reported as unknown, never as at_capacity', () => {
  const withNull = getMentorAvailability({ mentorCapacity: null, activeMenteeCount: 50, acceptingMentees: true });
  expect(withNull.capacityKnown).toBe(false);
  expect(withNull.status).toBe('available');

  const withUndefined = getMentorAvailability({ mentorCapacity: undefined, activeMenteeCount: 50, acceptingMentees: null });
  expect(withUndefined.capacityKnown).toBe(false);
  expect(withUndefined.status).toBe('available');
});
