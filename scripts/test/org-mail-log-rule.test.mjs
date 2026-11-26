// Unit tests for the org admin's mail log query and reason (#3955, src/lib/orgMailLogRule.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrgMailLogQuery, mailLogReason } from '../../src/lib/orgMailLogRule.ts';

test('only known values reach the query; anything else is no filter', () => {
  assert.deepEqual(parseOrgMailLogQuery(new URLSearchParams('status=FAILED&category=mentee-assigned&to=Rep@Shop.Example&days=30')), {
    status: 'FAILED', category: 'mentee-assigned', to: 'rep@shop.example', days: 30,
  });
  assert.deepEqual(parseOrgMailLogQuery(new URLSearchParams('status=DROP TABLE&category=%25&to=nope&days=365')), {
    status: null, category: null, to: null, days: 7,
  });
});

test('a stored error becomes one short line with no address', () => {
  assert.equal(mailLogReason(null), null);
  assert.equal(mailLogReason('Unsubscribed: mentorship_lifecycle'), 'Unsubscribed: mentorship_lifecycle');
  assert.equal(mailLogReason('550 <a@b.example> rejected\nstack…'), '550 <[email]> rejected');
  assert.ok(mailLogReason('x'.repeat(500)).length <= 120);
});
