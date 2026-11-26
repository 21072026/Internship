// Unit tests for who hears that a new lead was assigned to them (#3968).
//   node --test --experimental-strip-types scripts/test/lead-assigned-notice.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadAssignedNoticeDue } from '../../src/lib/leadAssignedNoticeRule.ts';

test('a lead another person assigned to a rep or an admin is announced', () => {
  assert.equal(leadAssignedNoticeDue({ ownerId: 'rep', ownerRole: 'MENTOR', actorId: 'admin' }), true);
  assert.equal(leadAssignedNoticeDue({ ownerId: 'adm', ownerRole: 'ADMIN', actorId: 'other' }), true);
});

test('a sessionless assignment (the default owner of a web request) is announced', () => {
  assert.equal(leadAssignedNoticeDue({ ownerId: 'rep', ownerRole: 'MENTOR', actorId: null }), true);
});

test('nobody is told about a lead they assigned to themselves', () => {
  assert.equal(leadAssignedNoticeDue({ ownerId: 'rep', ownerRole: 'MENTOR', actorId: 'rep' }), false);
});

test('only staff own leads: anybody else, or no owner, hears nothing', () => {
  for (const role of ['MENTEE', 'COMPANY', 'SOURCE', null]) {
    assert.equal(leadAssignedNoticeDue({ ownerId: 'x', ownerRole: role, actorId: 'admin' }), false, String(role));
  }
  assert.equal(leadAssignedNoticeDue({ ownerId: null, ownerRole: 'MENTOR', actorId: 'admin' }), false);
});
