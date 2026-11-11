import { test, expect } from '@playwright/test';
import {
  addableSeats,
  canManageProjectTeam,
  canWriteProjectSeries,
  memberAddRefusal,
  menteeConnectionsFromSeats,
  seatCounts,
  type RelationSeat,
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

// #3584: a mentee's circle from seats — group relations (#1804) included, only
// active participation counted, the org checked on the relation AND the person.
const org = { orgId: 'orgA', defaultOrgId: 'orgDefault' };
const seat = (relationId: string, userId: string, side: 'MENTOR' | 'MENTEE', over: Partial<RelationSeat> = {}): RelationSeat => ({
  relationId, userId, side,
  relationStatus: 'ACTIVE', relationOrgId: 'orgA', userOrgId: 'orgA',
  userActive: true, userState: 'ACTIVE', leftAt: null,
  ...over,
});

test('a group relation brings its mentors and its other mentees into the circle', { tag: '@smoke' }, () => {
  const seats = [
    seat('g', 'lead', 'MENTOR'), seat('g', 'me', 'MENTEE'), seat('g', 'peer', 'MENTEE'),
    seat('g', 'co', 'MENTOR'), seat('g', 'p2', 'MENTEE'),
    // A 1:1 of the co-mentor: "my mentor's other mentees", group-aware.
    seat('r', 'co', 'MENTOR'), seat('r', 'p3', 'MENTEE'),
  ];
  const c = menteeConnectionsFromSeats('me', seats, org);
  expect([...c.mentors].sort()).toEqual(['co', 'lead']);
  expect([...c.mentees].sort()).toEqual(['p2', 'p3', 'peer']);
});

test('only active participation counts: left, ended, benched and inactive seats drop out', { tag: '@smoke' }, () => {
  const seats = [
    seat('g', 'lead', 'MENTOR'), seat('g', 'me', 'MENTEE'),
    seat('g', 'left', 'MENTEE', { leftAt: new Date() }),
    seat('g', 'benched', 'MENTEE', { userState: 'BENCHED' }),
    seat('g', 'inactive', 'MENTEE', { userActive: false }),
    seat('g', 'leftMentor', 'MENTOR', { leftAt: new Date() }),
    // A completed group: none of it counts, the actor's own seat included.
    seat('done', 'oldLead', 'MENTOR', { relationStatus: 'COMPLETED' }),
    seat('done', 'me', 'MENTEE', { relationStatus: 'COMPLETED' }),
    seat('done', 'oldPeer', 'MENTEE', { relationStatus: 'COMPLETED' }),
  ];
  const c = menteeConnectionsFromSeats('me', seats, org);
  expect([...c.mentors]).toEqual(['lead']);
  expect([...c.mentees]).toEqual([]);
  // The actor's own seat must count too: a mentee who left has no circle there.
  expect(menteeConnectionsFromSeats('me', [seat('g', 'lead', 'MENTOR'), seat('g', 'me', 'MENTEE', { leftAt: new Date() })], org).mentors.size).toBe(0);
  // …and a benched mentee has none at all.
  expect(menteeConnectionsFromSeats('me', [seat('g', 'lead', 'MENTOR'), seat('g', 'me', 'MENTEE', { userState: 'BENCHED' })], org).mentors.size).toBe(0);
});

test('the org is checked on the relation and on the person, NULL reading as the default org', { tag: '@smoke' }, () => {
  expect(seatCounts(seat('g', 'x', 'MENTEE', { userOrgId: 'orgB' }), org)).toBe(false);
  expect(seatCounts(seat('g', 'x', 'MENTEE', { relationOrgId: 'orgB' }), org)).toBe(false);
  expect(seatCounts(seat('g', 'x', 'MENTEE', { userOrgId: null }), org)).toBe(false);
  const dflt = { orgId: 'orgDefault', defaultOrgId: 'orgDefault' };
  expect(seatCounts(seat('g', 'x', 'MENTEE', { userOrgId: null, relationOrgId: null }), dflt)).toBe(true);
  expect(seatCounts(seat('g', 'x', 'MENTEE', { userOrgId: null, relationOrgId: null }), { orgId: null, defaultOrgId: 'orgDefault' })).toBe(true);
  const seats = [seat('g', 'lead', 'MENTOR'), seat('g', 'me', 'MENTEE'), seat('g', 'foreign', 'MENTEE', { userOrgId: 'orgB' })];
  expect([...menteeConnectionsFromSeats('me', seats, org).mentees]).toEqual([]);
});
