// Unit test for the AI_PACKAGE grandfather backfill's run-once rule (#1738).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The backfill grants every existing org AI_PACKAGE on the deploy that adds
// the gate — and must never do it again, or every org created later would be
// grandfathered too and the gate would apply to nobody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldGrandfather, GRANDFATHER_NOTE } from '../../prisma/backfill-ai-package-grandfather.mjs';

test('the first run grants; any run after one left its mark does not', () => {
  assert.equal(shouldGrandfather(0), true);
  assert.equal(shouldGrandfather(1), false);
  assert.equal(shouldGrandfather(250), false);
});

test('the marker names the gate it grandfathers and the issue behind it', () => {
  assert.match(GRANDFATHER_NOTE, /AI_PACKAGE/);
  assert.match(GRANDFATHER_NOTE, /#1738/);
});
