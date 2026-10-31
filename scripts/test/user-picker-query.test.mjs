// Unit tests for the people-picker query rule (src/lib/userPickerQuery.ts, #1437).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PICKER_MAX_LIMIT, PICKER_ROLES, pickerLimit, pickerRoles } from '../../src/lib/userPickerQuery.ts';

test('no roles param → every picker role, never COMPANY or SOURCE', () => {
  assert.deepEqual(pickerRoles(null, null), [...PICKER_ROLES]);
  assert.ok(!pickerRoles(null, null).includes('COMPANY'));
});

test('roles param narrows, in the canonical order, case and spaces forgiven', () => {
  assert.deepEqual(pickerRoles('mentor, ADMIN', null), ['ADMIN', 'MENTOR']);
  assert.deepEqual(pickerRoles('MENTEE', null), ['MENTEE']);
});

test('a roles list naming no picker role answers an empty set, not the full one', () => {
  assert.deepEqual(pickerRoles('COMPANY,SOURCE', null), []);
  assert.deepEqual(pickerRoles('', null), []);
});

test('the single role filter intersects', () => {
  assert.deepEqual(pickerRoles(null, 'MENTOR'), ['MENTOR']);
  assert.deepEqual(pickerRoles('ADMIN,MENTOR', 'MENTEE'), []);
  assert.deepEqual(pickerRoles(null, 'COMPANY'), []);
});

test('limit: absent or malformed → unbounded (null), never a silent truncation', () => {
  assert.equal(pickerLimit(null), null);
  assert.equal(pickerLimit('abc'), null);
  assert.equal(pickerLimit('-5'), null);
  assert.equal(pickerLimit('0'), null);
  assert.equal(pickerLimit('2.5'), null);
});

test('limit: a positive integer is kept, a large one clamped', () => {
  assert.equal(pickerLimit('20'), 20);
  assert.equal(pickerLimit(' 7 '), 7);
  assert.equal(pickerLimit('10000'), PICKER_MAX_LIMIT);
});
