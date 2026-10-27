// #1808: the self-match limit, as a pure rule. No DB, no browser.
//
// The first test is the contract the issue asks to pin before anything else:
// every pre-#1808 caller passes no context, and must get exactly the answer it
// got before — whatever a mentor's selfMatchLimit says.
import { test, expect } from '@playwright/test';
import { countSelfSelected, getMentorAvailability, selfMatchReached } from '@/lib/mentorAvailability';
import { DIMENSIONS, type MatchMentor } from '@/lib/matching/dimensions';

const CAPACITIES = [null, undefined, 0, 1, 3];
const COUNTS = [0, 1, 3, 5];
const PREFS = [null, undefined, true, false];

test.describe('mentor load controls', { tag: '@smoke' }, () => {
  test('no context = the pre-#1808 answer, whatever the self-match inputs say', () => {
    for (const mentorCapacity of CAPACITIES)
      for (const activeMenteeCount of COUNTS)
        for (const acceptingMentees of PREFS) {
          const before = getMentorAvailability({ mentorCapacity, activeMenteeCount, acceptingMentees });
          // The pre-#1808 derivation, copied as the oracle.
          const capacityKnown = mentorCapacity != null;
          const atCapacity = capacityKnown && activeMenteeCount >= (mentorCapacity as number);
          const oracle =
            acceptingMentees === false
              ? { status: 'not_accepting', source: 'preference', capacityKnown }
              : { status: atCapacity ? 'at_capacity' : 'available', source: acceptingMentees === true ? 'preference' : 'capacity', capacityKnown };
          expect(before).toEqual(oracle);
          // A limit passed without a context, or under 'admin', changes nothing.
          for (const context of [undefined, 'admin'] as const) {
            expect(
              getMentorAvailability({ mentorCapacity, activeMenteeCount, acceptingMentees, selfMatchLimit: 0, selfSelectedCount: 9, context })
            ).toEqual(before);
          }
        }
  });

  test('self_select: a reached limit under free capacity reads self_match_full', () => {
    const full = getMentorAvailability({
      mentorCapacity: 6, activeMenteeCount: 3, acceptingMentees: true, selfMatchLimit: 3, selfSelectedCount: 3, context: 'self_select',
    });
    expect(full.status).toBe('self_match_full');
    expect(full.capacityKnown).toBe(true);
    // The same mentor, asked by an admin, is still assignable.
    expect(getMentorAvailability({ mentorCapacity: 6, activeMenteeCount: 3, acceptingMentees: true, selfMatchLimit: 3, selfSelectedCount: 3 }).status).toBe('available');
  });

  test('self_select: below the limit, without a limit, or for an unknown capacity stays available', () => {
    const base = { mentorCapacity: 6, activeMenteeCount: 2, acceptingMentees: null, context: 'self_select' as const };
    expect(getMentorAvailability({ ...base, selfMatchLimit: 3, selfSelectedCount: 2 }).status).toBe('available');
    expect(getMentorAvailability({ ...base, selfMatchLimit: null, selfSelectedCount: 50 }).status).toBe('available');
    expect(getMentorAvailability({ ...base, mentorCapacity: null, selfMatchLimit: 1, selfSelectedCount: 1 }).status).toBe('self_match_full');
  });

  test('self_select never masks a stronger status', () => {
    const args = { selfMatchLimit: 1, selfSelectedCount: 5, context: 'self_select' as const };
    expect(getMentorAvailability({ mentorCapacity: 2, activeMenteeCount: 2, acceptingMentees: true, ...args }).status).toBe('at_capacity');
    expect(getMentorAvailability({ mentorCapacity: 9, activeMenteeCount: 0, acceptingMentees: false, ...args }).status).toBe('not_accepting');
  });

  test('a limit of 0 closes self-selection entirely', () => {
    expect(selfMatchReached(0, 0)).toBe(true);
    expect(selfMatchReached(null, 100)).toBe(false);
    expect(selfMatchReached(undefined, 0)).toBe(false);
  });

  test('countSelfSelected: pending seats, approved-and-still-with-me seats, each mentee once', () => {
    const requests = [
      { menteeId: 'a', preferredMentorId: 'm', status: 'PENDING' },
      { menteeId: 'b', preferredMentorId: 'm', status: 'APPROVED' }, // still active with m
      { menteeId: 'c', preferredMentorId: 'm', status: 'APPROVED' }, // admin put c with someone else
      { menteeId: 'd', preferredMentorId: 'm', status: 'REJECTED' },
      { menteeId: 'b', preferredMentorId: 'm', status: 'APPROVED' }, // duplicate row, same mentee
      { menteeId: 'e', preferredMentorId: 'other', status: 'PENDING' },
      { menteeId: 'f', preferredMentorId: null, status: 'PENDING' },
    ];
    const pairs = [
      { mentorId: 'm', menteeId: 'b' },
      { mentorId: 'x', menteeId: 'c' },
    ];
    expect(countSelfSelected('m', requests, pairs)).toBe(2);
    expect(countSelfSelected('other', requests, pairs)).toBe(1);
    expect(countSelfSelected('nobody', requests, pairs)).toBe(0);
  });

  test('capacityHeadroom: an admin round still ranks a self-match-full mentor, a self-select round does not', () => {
    const mentor: MatchMentor = { id: 'm', mentorCapacity: 6, activeMenteeCount: 3, selfMatchLimit: 2, selfSelectedCount: 2 };
    const ctx = { now: new Date('2026-10-27T12:00:00Z') };
    expect(DIMENSIONS.capacityHeadroom({ id: 'me' }, mentor, {}, ctx).matched).toBe(true);
    const selfRound = DIMENSIONS.capacityHeadroom({ id: 'me' }, mentor, { selfSelect: true }, ctx);
    expect(selfRound.matched).toBe(false);
    expect(selfRound.detail).toContain('self_match_full');
  });
});
