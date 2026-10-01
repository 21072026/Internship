// Unit tests for the MARKETING shell follow-ups to #2647:
//   - the sales mode of the view switch (src/lib/appMode.ts, salesSurface.ts)
//   - the stale cross-tenant bell purge (prisma/purge-cross-tenant-notifications.mjs)
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterpartPath, modeOf, MODE_ROOT } from '../../src/lib/appMode.ts';
import { hasSalesSurface } from '../../src/lib/salesSurface.ts';
import { verticalCapabilities } from '../../src/lib/verticals.ts';
import { shouldPurge, INTERNSHIP_ONLY_TYPES, NAMED_FANOUT_TYPES } from '../../prisma/purge-cross-tenant-notifications.mjs';

const MARKETING = verticalCapabilities('MARKETING');
const INTERNSHIP = verticalCapabilities('INTERNSHIP');

test('the sales shell is a mode of its own, rooted at /sales', () => {
  assert.equal(MODE_ROOT.sales, '/sales');
  assert.equal(modeOf('/sales'), 'sales');
  assert.equal(modeOf('/sales/leads/abc'), 'sales');
  assert.equal(modeOf('/salesforce'), null);
});

test('switching admin ↔ sales keeps the context where both shells own it', () => {
  assert.equal(counterpartPath('/admin/candidates', 'sales'), '/sales/leads');
  assert.equal(counterpartPath('/admin/companies', 'sales'), '/sales/accounts');
  assert.equal(counterpartPath('/admin/board', 'sales'), '/sales/board');
  assert.equal(counterpartPath('/sales/leads', 'admin'), '/admin/candidates');
  assert.equal(counterpartPath('/sales/accounts', 'admin'), '/admin/companies');
  assert.equal(counterpartPath('/admin/settings', 'sales'), '/sales');
});

test('an ADMIN of MARKETING may also work the sales surface; INTERNSHIP never has one', () => {
  assert.equal(hasSalesSurface('ADMIN', MARKETING), true);
  assert.equal(hasSalesSurface('MENTOR', MARKETING), true);
  assert.equal(hasSalesSurface('MENTEE', MARKETING), false);
  assert.equal(hasSalesSurface('ADMIN', INTERNSHIP), false);
  assert.equal(hasSalesSurface('MENTOR', INTERNSHIP), false);
});

test('purge: an internship-only fan-out in a MARKETING admin bell goes, whatever it names', () => {
  for (const type of INTERNSHIP_ONLY_TYPES) {
    assert.equal(
      shouldPurge({ type, recipientRole: 'ADMIN', recipientVertical: 'MARKETING', subjectName: 'X', subjectInRecipientOrg: true }),
      true,
      type,
    );
  }
});

test('purge: a named fan-out survives only when the person is in the recipient org', () => {
  const base = { type: 'signup.new', recipientRole: 'ADMIN', recipientVertical: 'MARKETING', subjectName: 'Ömer' };
  assert.equal(shouldPurge({ ...base, subjectInRecipientOrg: false }), true);
  assert.equal(shouldPurge({ ...base, subjectInRecipientOrg: true }), false);
  // The other direction: a MARKETING sign-up in an INTERNSHIP admin's bell.
  assert.equal(shouldPurge({ ...base, recipientVertical: 'INTERNSHIP', subjectInRecipientOrg: false }), true);
});

test('purge never touches non-admin bells or non-fan-out types', () => {
  assert.equal(
    shouldPurge({ type: 'signup.new', recipientRole: 'MENTOR', recipientVertical: 'MARKETING', subjectName: 'Ömer', subjectInRecipientOrg: false }),
    false,
  );
  assert.equal(
    shouldPurge({ type: 'message.new', recipientRole: 'ADMIN', recipientVertical: 'MARKETING', subjectName: 'Ömer', subjectInRecipientOrg: false }),
    false,
  );
  assert.ok(!NAMED_FANOUT_TYPES.includes('message.new'));
});
