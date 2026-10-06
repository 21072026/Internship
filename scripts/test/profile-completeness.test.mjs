// Unit tests for the profile completeness rule (light gamification on /portal).
//
// Run: npm run test:profile-completeness  (node --test --experimental-strip-types)
//
// What is pinned here, because each one is a way the meter could quietly lie:
//   1. the weights sum to exactly 100, so a full profile reads 100 and the
//      percentage is a plain integer sum — no rounding to argue about;
//   2. an empty profile (or none at all) reads 0 and lists every field;
//   3. whitespace, an empty skills array, a skills array of blanks, a JSON
//      object in the skills column and a 0 graduation year all count as EMPTY —
//      the meter must never call a field done that matching cannot use;
//   4. the missing list is deterministic: heaviest first, fixed order on ties,
//      and independent of the order the input's keys arrive in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_FIELDS,
  profileCompleteness,
  profileFieldAnchor,
  completenessSnapshot,
  PROFILE_FIELD_ANCHOR_PREFIX,
} from '../../src/lib/profileCompleteness.ts';

const FULL = {
  skills: ['React', 'SQL'],
  targetPosition: 'Frontend developer',
  cvUrl: '/api/cv/abc',
  university: 'METU',
  department: 'Computer Engineering',
  interests: 'Accessibility',
  city: 'Ankara',
  graduationYear: 2027,
  bio: 'Hello.',
};

test('weights sum to 100 and keys are unique', () => {
  const sum = PROFILE_FIELDS.reduce((acc, f) => acc + f.weight, 0);
  assert.equal(sum, 100);
  assert.equal(new Set(PROFILE_FIELDS.map((f) => f.key)).size, PROFILE_FIELDS.length);
  for (const f of PROFILE_FIELDS) assert.ok(Number.isInteger(f.weight) && f.weight > 0, f.key);
});

test('a full profile is 100% with nothing missing', () => {
  assert.deepEqual(profileCompleteness(FULL), { percent: 100, missing: [] });
});

test('an empty or absent profile is 0% and lists every field, heaviest first', () => {
  const all = PROFILE_FIELDS.map((f) => f.key);
  assert.deepEqual(profileCompleteness({}), { percent: 0, missing: all });
  assert.deepEqual(profileCompleteness(null), { percent: 0, missing: all });
  assert.deepEqual(profileCompleteness(undefined), { percent: 0, missing: all });
  const weights = PROFILE_FIELDS.map((f) => f.weight);
  assert.deepEqual([...weights].sort((a, b) => b - a), weights, 'PROFILE_FIELDS must be ordered heaviest first');
});

test('values matching cannot use count as empty', () => {
  const blanks = [
    { skills: [] },
    { skills: ['  ', ''] },
    { skills: { React: true } },
    { skills: 'React' },
    { skills: [42] },
  ];
  for (const b of blanks) {
    const r = profileCompleteness({ ...FULL, ...b });
    assert.equal(r.percent, 75, JSON.stringify(b));
    assert.deepEqual(r.missing, ['skills']);
  }
  assert.deepEqual(profileCompleteness({ ...FULL, city: '   ' }).missing, ['city']);
  assert.deepEqual(profileCompleteness({ ...FULL, bio: null }).missing, ['bio']);
  assert.deepEqual(profileCompleteness({ ...FULL, cvUrl: '' }).missing, ['cv']);
  assert.deepEqual(profileCompleteness({ ...FULL, graduationYear: 0 }).missing, ['graduationYear']);
  assert.deepEqual(profileCompleteness({ ...FULL, graduationYear: Number.NaN }).missing, ['graduationYear']);
});

test('percent is the sum of the filled weights', () => {
  assert.deepEqual(profileCompleteness({ skills: ['Go'], city: 'Izmir' }).percent, 30);
  assert.deepEqual(profileCompleteness({ university: 'ITU', department: 'EE', bio: 'x' }).percent, 25);
});

test('the missing list does not depend on input key order', () => {
  const a = profileCompleteness({ bio: 'x', university: 'U', skills: ['A'] });
  const b = profileCompleteness({ skills: ['A'], university: 'U', bio: 'x' });
  assert.deepEqual(a, b);
  assert.deepEqual(a.missing, ['targetPosition', 'cv', 'department', 'interests', 'city', 'graduationYear']);
});

test('anchors are stable, unique ids', () => {
  const ids = PROFILE_FIELDS.map((f) => profileFieldAnchor(f.key));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(profileFieldAnchor('skills'), 'profile-field-skills');
  for (const id of ids) assert.match(id, /^[a-z][a-zA-Z-]*$/);
});

test('anchors share the prefix the profile page scrolls to', () => {
  for (const f of PROFILE_FIELDS) assert.ok(profileFieldAnchor(f.key).startsWith(PROFILE_FIELD_ANCHOR_PREFIX), f.key);
});

test('completenessSnapshot reads exactly the persisted row', () => {
  // A full PROFILE_SELECT-shaped row, plus columns the rule must ignore.
  const row = { ...FULL, id: 'u1', email: 'a@b.c', phone: '+90', timezone: 'Europe/Istanbul' };
  assert.deepEqual(completenessSnapshot(row), FULL);
  assert.deepEqual(profileCompleteness(completenessSnapshot(row)), { percent: 100, missing: [] });
  // Wrong types from a JSON body never count as filled.
  const odd = completenessSnapshot({ city: 42, graduationYear: '2027', bio: ['x'] });
  assert.equal(odd.city, null);
  assert.equal(odd.graduationYear, null);
  assert.equal(odd.bio, null);
  assert.deepEqual(completenessSnapshot(null), completenessSnapshot({}));
});
