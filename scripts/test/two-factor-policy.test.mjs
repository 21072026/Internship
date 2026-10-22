// Unit tests for the 2FA policy vocabulary (#1644).
//
// Run: npm run test:two-factor-policy  (node --test --experimental-strip-types)
//
// Pins what the settings form, the server-side gate and the coverage report
// all read from one pure module: which mode covers which role (`all` is every
// role the product has, COMPANY and SOURCE included), that "stricter" is set
// inclusion, and how many people a switch would hold at the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRE_2FA_MODES,
  TWO_FACTOR_ROLES,
  parseRequire2faMode,
  rolesCoveredBy,
  roleCoveredBy,
  isStricterMode,
  coveragePercentage,
  coverageFor,
  newlyHeldAtGate,
} from '../../src/lib/twoFactorPolicyRule.ts';

test('`all` covers every role the product has; the older modes keep their meaning', () => {
  assert.deepEqual([...rolesCoveredBy('off')], []);
  assert.deepEqual([...rolesCoveredBy('admins')], ['ADMIN']);
  assert.deepEqual([...rolesCoveredBy('admins_mentors')], ['ADMIN', 'MENTOR']);
  assert.deepEqual([...rolesCoveredBy('all')], [...TWO_FACTOR_ROLES]);
  for (const role of ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE', 'AFFILIATE']) {
    assert.equal(roleCoveredBy('all', role), true, `all must hold ${role}`);
  }
  assert.equal(roleCoveredBy('admins_mentors', 'COMPANY'), false);
  assert.equal(roleCoveredBy('all', 'ROBOT'), false, 'an unknown role is never held');
});

test('a stored value is parsed defensively', () => {
  for (const m of REQUIRE_2FA_MODES) assert.equal(parseRequire2faMode(m), m);
  assert.equal(parseRequire2faMode('everyone'), 'off');
  assert.equal(parseRequire2faMode(null), 'off');
  assert.equal(parseRequire2faMode(undefined), 'off');
});

test('stricter is set inclusion: a mode is stricter when it covers a role the other does not', () => {
  assert.equal(isStricterMode('all', 'off'), true);
  assert.equal(isStricterMode('all', 'admins_mentors'), true);
  assert.equal(isStricterMode('admins_mentors', 'admins'), true);
  assert.equal(isStricterMode('admins', 'admins'), false, 'the same mode is not stricter');
  assert.equal(isStricterMode('admins', 'admins_mentors'), false, 'relaxing is never stricter');
  assert.equal(isStricterMode('off', 'all'), false);
});

const ROWS = [
  { role: 'ADMIN', total: 2, enabled: 2, percentage: 100 },
  { role: 'MENTOR', total: 9, enabled: 5, percentage: 55 },
  { role: 'MENTEE', total: 300, enabled: 0, percentage: 0 },
  { role: 'COMPANY', total: 4, enabled: 1, percentage: 25 },
  { role: 'SOURCE', total: 0, enabled: 0, percentage: 100 },
];

test('coverage arithmetic: integer percent, and a role nobody holds reads as fully covered', () => {
  assert.equal(coveragePercentage(5, 9), 55);
  assert.equal(coveragePercentage(0, 0), 100);
  assert.equal(coveragePercentage(1, 3), 33);
  assert.deepEqual(coverageFor(ROWS, ['ADMIN', 'MENTOR']), { total: 11, enabled: 7, percentage: 63 });
  assert.deepEqual(coverageFor(ROWS, []), { total: 0, enabled: 0, percentage: 100 });
});

test('a stricter switch counts exactly the people in the NEWLY covered roles without 2FA', () => {
  // off -> all: everyone without 2FA.
  assert.equal(newlyHeldAtGate('all', 'off', ROWS), 4 + 300 + 3);
  // admins_mentors -> all: the mentors already held do not count again.
  assert.equal(newlyHeldAtGate('all', 'admins_mentors', ROWS), 300 + 3);
  // admins -> admins_mentors: the four mentors without 2FA.
  assert.equal(newlyHeldAtGate('admins_mentors', 'admins', ROWS), 4);
  // Not stricter: nobody new is held.
  assert.equal(newlyHeldAtGate('admins', 'all', ROWS), 0);
  assert.equal(newlyHeldAtGate('all', 'all', ROWS), 0);
});
