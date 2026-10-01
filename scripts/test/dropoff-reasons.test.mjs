// Unit tests for the per-vertical drop-off reason lists (#2573).
// Run: node --test --experimental-strip-types scripts/test/dropoff-reasons.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DROPOFF_REASON_CODES,
  MARKETING_DROPOFF_REASON_CODES,
  dropoffReasonCodesFor,
  isDropoffReasonCodeFor,
  isDropoffReasonCode,
} from '../../src/lib/dropoffReasons.ts';

test('MARKETING gets the lost-deal list', () => {
  assert.deepEqual([...dropoffReasonCodesFor('MARKETING')], [
    'PRICE', 'MISSING_MARKETPLACE', 'MISSING_FEATURE', 'COMPETITOR', 'NO_RESPONSE',
    'NOT_A_FIT', 'BUSINESS_CLOSED', 'TECHNICAL_ISSUE', 'OTHER',
  ]);
});

test('INTERNSHIP, an unknown and a missing vertical keep the hiring list unchanged', () => {
  for (const v of ['INTERNSHIP', 'SOMETHING_ELSE', null, undefined]) {
    assert.equal(dropoffReasonCodesFor(v), DROPOFF_REASON_CODES, String(v));
  }
});

test('each vertical refuses the other product’s codes', () => {
  assert.equal(isDropoffReasonCodeFor('MARKETING', 'SKILL_MISMATCH'), false);
  assert.equal(isDropoffReasonCodeFor('MARKETING', 'COMPETITOR'), true);
  assert.equal(isDropoffReasonCodeFor('INTERNSHIP', 'COMPETITOR'), false);
  assert.equal(isDropoffReasonCodeFor('INTERNSHIP', 'SKILL_MISMATCH'), true);
});

test('shared codes mean the same thing in both lists', () => {
  for (const code of ['NO_RESPONSE', 'OTHER']) {
    assert.ok(isDropoffReasonCodeFor('MARKETING', code) && isDropoffReasonCodeFor('INTERNSHIP', code), code);
  }
});

test('reading a stored row accepts either product’s code', () => {
  for (const code of [...DROPOFF_REASON_CODES, ...MARKETING_DROPOFF_REASON_CODES]) assert.equal(isDropoffReasonCode(code), true);
  assert.equal(isDropoffReasonCode('NOPE'), false);
});
