// Unit tests for the affiliate row a support question points at
// (src/lib/affiliateRecordRefRule.ts, docs/affiliate-module.md, #3353).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordRef, recordRef } from '../../src/lib/affiliateRecordRefRule.ts';

test('a reference round-trips for both kinds', () => {
  for (const kind of ['commission', 'customer']) {
    const ref = recordRef(kind, 'cm1abc2def3');
    assert.equal(ref, `affiliate:${kind}:cm1abc2def3`);
    assert.deepEqual(parseRecordRef(ref), { kind, id: 'cm1abc2def3' });
  }
});

test('anything that is not exactly one of ours is refused', () => {
  for (const raw of [
    null,
    42,
    '',
    'affiliate:payout:cm1abc', // not a kind a partner may ask about
    'other:commission:cm1abc',
    'affiliate:commission:',
    'affiliate:commission:CM1ABC', // ids are lower-case
    'affiliate:commission:cm1abc:extra',
    'affiliate:commission:../x',
    `affiliate:commission:${'a'.repeat(41)}`,
  ]) {
    assert.equal(parseRecordRef(raw), null, String(raw));
  }
});
