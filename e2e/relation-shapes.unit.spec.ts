// Unit tests for the relation shapes vocabulary and the membership rule
// (#1804). Pure node — no browser, no DB.
//
// Guarded: the scalar pair is always a member; a seat beyond the pair is a
// member until it is left; a mirror seat of the pair grants nothing (a stale
// one, after a mentor was corrected in place, must not keep anyone in); the
// whitelists hold.
import { test, expect } from '@playwright/test';
import { currentMemberIds, isParticipantRole, isRelationType, pairSeats, DEFAULT_RELATION_TYPE } from '@/lib/relationShapes';

const pair = { mentorId: 'mentor', menteeId: 'mentee' };
const seat = (userId: string, over: Partial<{ role: string; isPrimaryPair: boolean; leftAt: Date | null }> = {}) => ({
  userId, role: 'MENTEE', isPrimaryPair: false, leftAt: null, ...over,
});

test('the pair is always in; an open seat beyond it is in; a left seat is not', { tag: '@smoke' }, () => {
  const ids = currentMemberIds(pair, [seat('third'), seat('gone', { leftAt: new Date() })]);
  expect([...ids].sort()).toEqual(['mentee', 'mentor', 'third']);
});

test('a mirror seat grants nothing, so a stale one never keeps a former mentor in', { tag: '@smoke' }, () => {
  const ids = currentMemberIds(pair, [seat('former-mentor', { role: 'MENTOR', isPrimaryPair: true })]);
  expect(ids.has('former-mentor')).toBe(false);
});

test('pairSeats mirrors the scalars, flagged as the pair', { tag: '@smoke' }, () => {
  expect(pairSeats(pair)).toEqual([
    { userId: 'mentor', role: 'MENTOR', isPrimaryPair: true },
    { userId: 'mentee', role: 'MENTEE', isPrimaryPair: true },
  ]);
});

test('the whitelists', { tag: '@smoke' }, () => {
  expect(DEFAULT_RELATION_TYPE).toBe('ONE_TO_ONE');
  for (const t of ['ONE_TO_ONE', 'GROUP', 'PEER', 'REVERSE', 'FLASH']) expect(isRelationType(t)).toBe(true);
  expect(isRelationType('one_to_one')).toBe(false);
  expect(isParticipantRole('FACILITATOR')).toBe(true);
  expect(isParticipantRole('ADMIN')).toBe(false);
});
