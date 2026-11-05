import { test, expect } from '@playwright/test';
import {
  addableSeats,
  canManageProjectTeam,
  canWriteProjectSeries,
  memberAddRefusal,
  nonManagerStatus,
  NO_CONNECTIONS,
} from '../src/lib/projectTeamRule';

// Who manages a project's team and whom they may seat (#2272). No browser, no database.

const owner = { id: 'owner', role: 'MENTEE' };
const project = {
  ownerUserId: 'owner',
  members: [
    { userId: 'owner', role: 'OWNER' },
    { userId: 'mentorMember', role: 'MENTOR' },
    { userId: 'menteeMember', role: 'MENTEE' },
  ],
};
const active = (id: string, role: string) => ({ id, role, isActive: true });
// The mentee owner's circle: their mentor `m1`, and `peer`, another mentee of m1.
const menteeCircle = { mentors: new Set(['m1']), mentees: new Set(['peer']) };

test('a team is managed by an admin, an OWNER member or the legacy owner pointer', { tag: '@smoke' }, () => {
  expect(canManageProjectTeam(owner, project)).toBe(true);
  expect(canManageProjectTeam({ id: 'x', role: 'ADMIN' }, project)).toBe(true);
  expect(canManageProjectTeam({ id: 'legacy', role: 'MENTEE' }, { ownerUserId: 'legacy', members: [] })).toBe(true);
  expect(canManageProjectTeam({ id: 'menteeMember', role: 'MENTEE' }, project)).toBe(false);
  expect(canManageProjectTeam({ id: 'mentorMember', role: 'MENTOR' }, project)).toBe(false);
  expect(canManageProjectTeam({ id: 'stranger', role: 'MENTOR' }, project)).toBe(false);
});

test('a non-manager on the team is told 403; anyone else gets the 404 of a missing project', { tag: '@smoke' }, () => {
  expect(nonManagerStatus('menteeMember', project)).toBe(403);
  expect(nonManagerStatus('stranger', project)).toBe(404);
});

test('a mentee owner may seat only their own mentor and that mentor’s other mentees', { tag: '@smoke' }, () => {
  expect(addableSeats(owner, active('m1', 'MENTOR'), menteeCircle)).toEqual(['OWNER', 'MENTOR']);
  expect(addableSeats(owner, active('peer', 'MENTEE'), menteeCircle)).toEqual(['MENTEE']);
  // An unconnected mentor or mentee of the same org is outside the set.
  expect(addableSeats(owner, active('m2', 'MENTOR'), menteeCircle)).toEqual([]);
  expect(addableSeats(owner, active('stranger', 'MENTEE'), menteeCircle)).toEqual([]);
  // An admin is never "connected" to a mentee through a mentorship.
  expect(addableSeats(owner, active('admin', 'ADMIN'), menteeCircle)).toEqual([]);
  // Not themselves, not an inactive account, not a missing (or foreign-tenant) one.
  expect(addableSeats(owner, active('owner', 'MENTEE'), { mentors: new Set(), mentees: new Set(['owner']) })).toEqual([]);
  expect(addableSeats(owner, { id: 'peer', role: 'MENTEE', isActive: false }, menteeCircle)).toEqual([]);
  expect(addableSeats(owner, null, menteeCircle)).toEqual([]);
});

test('a refused target answers like a missing one; a known one in the wrong seat is a 400', { tag: '@smoke' }, () => {
  expect(memberAddRefusal(owner, active('stranger', 'MENTEE'), 'MENTEE', menteeCircle)).toEqual({ status: 404, code: 'not_addable' });
  expect(memberAddRefusal(owner, null, 'MENTEE', menteeCircle)).toEqual({ status: 404, code: 'not_addable' });
  expect(memberAddRefusal(owner, active('peer', 'MENTEE'), 'OWNER', menteeCircle)).toEqual({ status: 400, code: 'wrong_seat' });
  expect(memberAddRefusal(owner, active('peer', 'MENTEE'), 'MENTEE', menteeCircle)).toBeNull();
  expect(memberAddRefusal(owner, active('m1', 'MENTOR'), 'OWNER', menteeCircle)).toBeNull();
});

test('a mentor keeps their rule: any mentor/admin, and only their own mentees', { tag: '@smoke' }, () => {
  const mentor = { id: 'm1', role: 'MENTOR' };
  const own = { mentors: new Set<string>(), mentees: new Set(['mine']) };
  expect(addableSeats(mentor, active('m2', 'MENTOR'), own)).toEqual(['OWNER', 'MENTOR']);
  expect(addableSeats(mentor, active('admin', 'ADMIN'), own)).toEqual(['OWNER', 'MENTOR']);
  expect(addableSeats(mentor, active('mine', 'MENTEE'), own)).toEqual(['MENTEE']);
  expect(addableSeats(mentor, active('theirs', 'MENTEE'), own)).toEqual([]);
});

test('an admin seats anyone active by their structural role; other roles seat nobody', { tag: '@smoke' }, () => {
  const admin = { id: 'a', role: 'ADMIN' };
  expect(addableSeats(admin, active('x', 'MENTEE'), NO_CONNECTIONS)).toEqual(['MENTEE']);
  expect(addableSeats(admin, active('y', 'MENTOR'), NO_CONNECTIONS)).toEqual(['OWNER', 'MENTOR']);
  expect(addableSeats(admin, active('c', 'COMPANY'), NO_CONNECTIONS)).toEqual([]);
  expect(addableSeats({ id: 'c', role: 'COMPANY' }, active('y', 'MENTOR'), menteeCircle)).toEqual([]);
  expect(addableSeats({ id: 's', role: 'SOURCE' }, active('peer', 'MENTEE'), menteeCircle)).toEqual([]);
});

test('a project series is written by its managers and MENTOR members, never a plain mentee member', { tag: '@smoke' }, () => {
  expect(canWriteProjectSeries(owner, project)).toBe(true);
  expect(canWriteProjectSeries({ id: 'mentorMember', role: 'MENTOR' }, project)).toBe(true);
  expect(canWriteProjectSeries({ id: 'menteeMember', role: 'MENTEE' }, project)).toBe(false);
  expect(canWriteProjectSeries({ id: 'stranger', role: 'MENTOR' }, project)).toBe(false);
  expect(canWriteProjectSeries({ id: 'x', role: 'ADMIN' }, project)).toBe(true);
});
