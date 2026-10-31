// Team seats at a company (#1870, docs/company-team-seats.md).
// Run: node --test --experimental-strip-types scripts/test/company-seats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_ACTIONS,
  IMPLICIT_SEAT_ROLE,
  SEAT_ROLES,
  companyCan,
  isSeatRole,
  leavesNoOwner,
  seatLimitReached,
} from '../../src/lib/companySeats.ts';

test('the action table is the issue\'s, role by role', () => {
  const allowed = (action) => SEAT_ROLES.filter((r) => companyCan(r, action));
  assert.deepEqual(allowed('requisition.write'), ['OWNER', 'RECRUITER', 'HIRING_MANAGER']);
  assert.deepEqual(allowed('application.stage.write'), ['OWNER', 'RECRUITER', 'HIRING_MANAGER']);
  assert.deepEqual(allowed('application.read'), ['OWNER', 'RECRUITER', 'HIRING_MANAGER', 'INTERVIEWER']);
  assert.deepEqual(allowed('outreach.request'), ['OWNER', 'RECRUITER']);
  assert.deepEqual(allowed('interview.request'), ['OWNER', 'RECRUITER', 'HIRING_MANAGER']);
  assert.deepEqual(allowed('company.profile.write'), ['OWNER']);
  assert.deepEqual(allowed('team.manage'), ['OWNER']);
  assert.deepEqual(allowed('entitlement.read'), ['OWNER']);
  assert.deepEqual(allowed('talentPool.search'), ['OWNER', 'RECRUITER']);
  assert.equal(COMPANY_ACTIONS.length, 9);
});

test('an INTERVIEWER writes nothing', () => {
  for (const action of COMPANY_ACTIONS) {
    if (action === 'application.read') continue;
    assert.equal(companyCan('INTERVIEWER', action), false, action);
  }
});

test('unknown roles fail closed; the implicit seat is OWNER', () => {
  for (const action of COMPANY_ACTIONS) {
    assert.equal(companyCan(null, action), false);
    assert.equal(companyCan('owner', action), false);
    assert.equal(companyCan('ADMIN', action), false);
  }
  assert.equal(IMPLICIT_SEAT_ROLE, 'OWNER');
  assert.ok(isSeatRole('HIRING_MANAGER'));
  assert.ok(!isSeatRole('MANAGER'));
});

test('the last owner cannot be demoted or removed', () => {
  assert.equal(leavesNoOwner({ owners: 1, targetIsOwner: true, nextRole: 'RECRUITER' }), true);
  assert.equal(leavesNoOwner({ owners: 1, targetIsOwner: true, nextRole: null }), true);
  assert.equal(leavesNoOwner({ owners: 2, targetIsOwner: true, nextRole: null }), false);
  assert.equal(leavesNoOwner({ owners: 1, targetIsOwner: true, nextRole: 'OWNER' }), false);
  assert.equal(leavesNoOwner({ owners: 1, targetIsOwner: false, nextRole: null }), false);
});

test('a null quota is unlimited; a number is a hard cap', () => {
  assert.equal(seatLimitReached({ quota: null, used: 10_000 }), false);
  assert.equal(seatLimitReached({ quota: 3, used: 2 }), false);
  assert.equal(seatLimitReached({ quota: 3, used: 3 }), true);
  assert.equal(seatLimitReached({ quota: 0, used: 0 }), true);
});
