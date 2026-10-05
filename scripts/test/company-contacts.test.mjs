// Unit tests for an account's address book (#2442, docs/company-contacts.md).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// WHAT THIS PINS
//   The primary contact is the Company.contact* columns, not a row, so "one
//   primary" is structural. What can still go wrong is the SWAP: a person lost,
//   a person invented, or a repeated request swapping the two back. And the
//   duplicate test must see the primary as well as the rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIMARY_CONTACT_ID,
  contactAsPrimary,
  emailTaken,
  hasPrimary,
  normalizeContact,
  primaryAsContact,
  primarySwap,
} from '../../src/lib/companyContactsRule.ts';

const NONE = { contactName: null, contactEmail: null, contactPhone: null, contactPosition: null };
const ADA = { contactName: 'Ada Lovelace', contactEmail: 'ada@shop.example', contactPhone: '+49 30 1', contactPosition: 'CEO' };

test('the primary id is a fixed word, never a row id', () => {
  assert.equal(PRIMARY_CONTACT_ID, 'primary');
});

test('normalizeContact trims, blanks become null and the address is lower-cased', () => {
  assert.deepEqual(normalizeContact({ name: '  Bob  ', email: ' Bob@Shop.Example ', phone: '  ', position: '' }), {
    name: 'Bob',
    email: 'bob@shop.example',
    phone: null,
    position: null,
  });
  assert.deepEqual(normalizeContact({}), { name: '', email: null, phone: null, position: null });
});

test('hasPrimary: any one of the four columns is a primary', () => {
  assert.equal(hasPrimary(NONE), false);
  assert.equal(hasPrimary({ ...NONE, contactPhone: '1' }), true);
  assert.equal(hasPrimary({ ...NONE, contactPosition: 'CFO' }), true);
  assert.equal(hasPrimary(ADA), true);
});

test('the primary as a contact, and back, is lossless', () => {
  const asContact = primaryAsContact(ADA);
  assert.deepEqual(asContact, { name: 'Ada Lovelace', email: 'ada@shop.example', phone: '+49 30 1', position: 'CEO' });
  assert.deepEqual(contactAsPrimary(asContact), ADA);
  // A nameless primary reads as its address, so the row it becomes is not blank.
  assert.equal(primaryAsContact({ ...NONE, contactEmail: 'Ops@Shop.example' }).name, 'Ops@Shop.example');
  assert.equal(primaryAsContact({ ...NONE, contactEmail: 'Ops@Shop.example' }).email, 'ops@shop.example');
});

test('primarySwap: the chosen person becomes the columns, the previous primary becomes a row', () => {
  const bob = { name: 'Bob', email: 'bob@shop.example', phone: null, position: 'Buyer' };
  const { primary, demoted } = primarySwap(ADA, bob);
  assert.deepEqual(primary, { contactName: 'Bob', contactEmail: 'bob@shop.example', contactPhone: null, contactPosition: 'Buyer' });
  assert.deepEqual(demoted, { name: 'Ada Lovelace', email: 'ada@shop.example', phone: '+49 30 1', position: 'CEO' });
});

test('primarySwap invents nobody when the account had no primary', () => {
  const { demoted } = primarySwap(NONE, { name: 'Bob', email: null, phone: null, position: null });
  assert.equal(demoted, null);
});

test('emailTaken sees the primary and the rows, ignores the row being edited, and never matches null', () => {
  const rows = [
    { id: 'r1', email: 'bob@shop.example' },
    { id: 'r2', email: null },
  ];
  assert.equal(emailTaken('ADA@shop.example', ADA, rows), true, 'the primary address');
  assert.equal(emailTaken('bob@shop.example', ADA, rows), true, 'a row address');
  assert.equal(emailTaken('bob@shop.example', ADA, rows, 'r1'), false, 'the row itself');
  assert.equal(emailTaken('new@shop.example', ADA, rows), false);
  assert.equal(emailTaken(null, ADA, rows), false, 'several contacts may have no address');
  assert.equal(emailTaken('x@y.z', NONE, []), false);
});
