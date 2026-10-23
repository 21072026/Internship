// Unit tests for the customer-mail lock's decision (src/lib/customerMailLockRule.ts):
// a MARKETING org's lead, customer or contact gets no mail at all unless the
// operator opened it on the server; staff always do; the internship product
// is never affected. Run:
//   node --test --experimental-strip-types scripts/test/customer-mail-lock.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOMER_MAIL_LOCK_REASON,
  customerMailUnlocked,
  recipientKindOfRole,
  recipientLocked,
} from '../../src/lib/customerMailLockRule.ts';

test('the lock is ON unless the operator sets MARKETING_CUSTOMER_MAIL_ENABLED to 1/true', () => {
  assert.equal(customerMailUnlocked({}), false);
  assert.equal(customerMailUnlocked({ MARKETING_CUSTOMER_MAIL_ENABLED: '' }), false);
  assert.equal(customerMailUnlocked({ MARKETING_CUSTOMER_MAIL_ENABLED: '0' }), false);
  assert.equal(customerMailUnlocked({ MARKETING_CUSTOMER_MAIL_ENABLED: 'yes' }), false);
  assert.equal(customerMailUnlocked({ MARKETING_CUSTOMER_MAIL_ENABLED: '1' }), true);
  assert.equal(customerMailUnlocked({ MARKETING_CUSTOMER_MAIL_ENABLED: ' TRUE ' }), true);
});

test('every non-staff recipient of a MARKETING org is locked — leads, customers, contacts, anyone else', () => {
  for (const kind of ['lead', 'customer', 'contact', 'other']) {
    assert.equal(recipientLocked({ vertical: 'MARKETING', kind }, false), true, kind);
  }
});

test('the org\'s own staff still get their mail', () => {
  assert.equal(recipientLocked({ vertical: 'MARKETING', kind: 'staff' }, false), false);
});

test('the internship product, or a recipient no org was found for, is never locked here', () => {
  for (const kind of ['lead', 'customer', 'contact', 'other', 'staff']) {
    assert.equal(recipientLocked({ vertical: 'INTERNSHIP', kind }, false), false);
    assert.equal(recipientLocked({ vertical: null, kind }, false), false);
  }
});

test('opened by the operator, nothing is locked', () => {
  assert.equal(recipientLocked({ vertical: 'MARKETING', kind: 'lead' }, true), false);
});

test('roles: ADMIN and MENTOR are staff; MENTEE a lead; COMPANY a customer; anything else other', () => {
  assert.equal(recipientKindOfRole('ADMIN'), 'staff');
  assert.equal(recipientKindOfRole('MENTOR'), 'staff');
  assert.equal(recipientKindOfRole('MENTEE'), 'lead');
  assert.equal(recipientKindOfRole('COMPANY'), 'customer');
  assert.equal(recipientKindOfRole('SOURCE'), 'other');
  assert.equal(recipientKindOfRole(null), 'other');
  assert.match(CUSTOMER_MAIL_LOCK_REASON, /locked/i);
});
