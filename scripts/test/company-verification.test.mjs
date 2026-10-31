// Employer verification (#1865, docs/company-verification.md).
// Run: node --test --experimental-strip-types scripts/test/company-verification.test.mjs
//
// The gate fails closed (an unknown status is not verified), only an OPEN
// requisition is a publish, the admin's moves follow the table and a refusal
// carries its reason, and a COMPANY user's self-edit is refused field by field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_SELF_EDITABLE_FIELDS,
  COMPANY_VERIFICATION_STATUSES,
  VERIFICATION_ACTIONS,
  VERIFIED_COMPANY_WHERE,
  availableVerificationActions,
  companySelfEditRefusedFields,
  isCompanyVerified,
  publishRefused,
  verificationTransition,
} from '../../src/lib/companyVerification.ts';

test('only VERIFIED is visible; anything else fails closed', () => {
  assert.equal(isCompanyVerified('VERIFIED'), true);
  for (const s of ['PENDING', 'REJECTED', 'SUSPENDED', 'verified', '', null, undefined]) assert.equal(isCompanyVerified(s), false);
  assert.deepEqual(VERIFIED_COMPANY_WHERE, { company: { is: { verificationStatus: 'VERIFIED' } } });
});

test('only a move to OPEN is a publish', () => {
  assert.equal(publishRefused({ companyStatus: 'PENDING', nextRequisitionStatus: 'OPEN' }), true);
  assert.equal(publishRefused({ companyStatus: 'SUSPENDED', nextRequisitionStatus: 'OPEN' }), true);
  assert.equal(publishRefused({ companyStatus: 'PENDING', nextRequisitionStatus: 'DRAFT' }), false);
  assert.equal(publishRefused({ companyStatus: 'VERIFIED', nextRequisitionStatus: 'OPEN' }), false);
});

test('the admin table: approve / reject / suspend / reinstate', () => {
  assert.deepEqual(verificationTransition({ from: 'PENDING', action: 'approve' }), { ok: true, to: 'VERIFIED', reason: null });
  assert.deepEqual(verificationTransition({ from: 'PENDING', action: 'reject', reason: ' Fake domain ' }), { ok: true, to: 'REJECTED', reason: 'Fake domain' });
  assert.deepEqual(verificationTransition({ from: 'PENDING', action: 'reject' }), { ok: false, code: 'reason_required' });
  assert.deepEqual(verificationTransition({ from: 'VERIFIED', action: 'suspend', reason: 'Spam' }), { ok: true, to: 'SUSPENDED', reason: 'Spam' });
  assert.deepEqual(verificationTransition({ from: 'SUSPENDED', action: 'reinstate', reason: 'ignored' }), { ok: true, to: 'VERIFIED', reason: null });
  assert.deepEqual(verificationTransition({ from: 'VERIFIED', action: 'approve' }), { ok: false, code: 'not_allowed' });
  assert.deepEqual(verificationTransition({ from: 'REJECTED', action: 'suspend', reason: 'x' }), { ok: false, code: 'not_allowed' });
  assert.deepEqual(verificationTransition({ from: 'PENDING', action: 'reject', reason: 'x'.repeat(1001) }), { ok: false, code: 'reason_too_long' });
});

test('availableVerificationActions offers exactly what the transition allows', () => {
  for (const from of COMPANY_VERIFICATION_STATUSES) {
    const offered = availableVerificationActions(from);
    for (const action of VERIFICATION_ACTIONS) {
      const ok = verificationTransition({ from, action, reason: 'r' }).ok;
      assert.equal(offered.includes(action), ok, `${from} ${action}`);
    }
  }
});

test('a COMPANY self-edit may name exactly six fields', () => {
  assert.deepEqual([...COMPANY_SELF_EDITABLE_FIELDS].sort(), ['address', 'contactEmail', 'description', 'industry', 'logoUrl', 'size']);
  assert.deepEqual(companySelfEditRefusedFields({ description: 'x', logoUrl: '' }), []);
  assert.deepEqual(companySelfEditRefusedFields({ description: 'x', quota: 5, verificationStatus: 'VERIFIED', orgId: 'o', name: 'n' }), [
    'name',
    'orgId',
    'quota',
    'verificationStatus',
  ]);
  assert.deepEqual(companySelfEditRefusedFields(null), []);
});
