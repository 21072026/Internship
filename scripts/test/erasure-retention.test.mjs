// Unit tests for how long an erasure's KEPT records live (#2098,
// src/lib/erasureRetentionRule.ts).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTACT_PROOF_RETENTION_YEARS,
  PAYOUT_DETAILS_RETENTION_YEARS,
  retainedRecordExpiry,
  retainedRecordCutoff,
  payoutDetailsAnchor,
} from '../../src/lib/erasureRetentionRule.ts';

const d = (s) => new Date(s);

test('the two periods are the rights holder’s decision: 3 and 10 years', () => {
  assert.equal(CONTACT_PROOF_RETENTION_YEARS, 3);
  assert.equal(PAYOUT_DETAILS_RETENTION_YEARS, 10);
});

test('the period starts at the end of the anchor’s calendar year', () => {
  assert.equal(retainedRecordExpiry(d('2026-01-01T00:00:00Z'), 3).toISOString(), '2030-01-01T00:00:00.000Z');
  assert.equal(retainedRecordExpiry(d('2026-12-31T23:59:59Z'), 3).toISOString(), '2030-01-01T00:00:00.000Z');
  assert.equal(retainedRecordExpiry(d('2026-06-15T12:00:00Z'), 10).toISOString(), '2037-01-01T00:00:00.000Z');
});

test('the SQL cutoff and the expiry agree on every side of a year boundary', () => {
  const anchors = ['2020-01-01T00:00:00Z', '2020-07-01T00:00:00Z', '2020-12-31T23:59:59.999Z', '2021-01-01T00:00:00Z'].map(d);
  const nows = [
    '2023-12-31T23:59:59.999Z', '2024-01-01T00:00:00Z', '2024-06-01T00:00:00Z', '2024-12-31T23:59:59.999Z',
    '2025-01-01T00:00:00Z', '2030-12-31T23:59:59.999Z', '2031-01-01T00:00:00Z', '2032-01-01T00:00:00Z',
  ].map(d);
  for (const years of [3, 10]) {
    for (const anchor of anchors) {
      for (const now of nows) {
        const byExpiry = retainedRecordExpiry(anchor, years).getTime() <= now.getTime();
        const byCutoff = anchor.getTime() < retainedRecordCutoff(now, years).getTime();
        assert.equal(byCutoff, byExpiry, `years=${years} anchor=${anchor.toISOString()} now=${now.toISOString()}`);
      }
    }
  }
});

test('an erasure in 2026 keeps the contact proof through 2029, never a day less', () => {
  const erased = d('2026-10-29T10:00:00Z');
  assert.equal(erased < retainedRecordCutoff(d('2029-12-31T23:59:59Z'), 3), false);
  assert.equal(erased < retainedRecordCutoff(d('2030-01-01T03:20:00Z'), 3), true);
});

test('payout details: no clock while the account lives', () => {
  assert.equal(payoutDetailsAnchor({ accountErasedAt: null, noticeEffectiveAt: d('2020-01-01Z'), lastPaidAt: d('2020-01-01Z') }), null);
});

test('payout details: the clock starts at the LAST end of the relationship', () => {
  const erased = d('2026-03-01T00:00:00Z');
  assert.equal(payoutDetailsAnchor({ accountErasedAt: erased, noticeEffectiveAt: null, lastPaidAt: null }), erased);
  // Paid after the erasure: the booking that used the IBAN is the later end.
  const paid = d('2027-02-01T00:00:00Z');
  assert.equal(payoutDetailsAnchor({ accountErasedAt: erased, noticeEffectiveAt: null, lastPaidAt: paid }), paid);
  // Termination taking effect after both.
  const notice = d('2027-06-30T00:00:00Z');
  assert.equal(payoutDetailsAnchor({ accountErasedAt: erased, noticeEffectiveAt: notice, lastPaidAt: paid }), notice);
  // Earlier dates never pull it back.
  assert.equal(payoutDetailsAnchor({ accountErasedAt: erased, noticeEffectiveAt: d('2025-01-01Z'), lastPaidAt: d('2024-01-01Z') }), erased);
});
