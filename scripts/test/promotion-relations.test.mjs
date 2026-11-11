// Unit tests for the promotion rule (#1506, src/lib/promotionRelationsRule.ts).
//
// Run: node --test --experimental-strip-types scripts/test/promotion-relations.test.mjs
//
// The two promises it keeps: an account with open mentee relations is never
// promoted without the admin's choice (and there is no default), and one
// without them promotes exactly as before, whatever the request carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMOTION_CHOICES, PROMOTION_END_REASON, checkPromotionChoice, isPromotionChoice } from '../../src/lib/promotionRelationsRule.ts';

test('the vocabulary is a whitelist, and END records changed_goals', () => {
  assert.deepEqual([...PROMOTION_CHOICES], ['COACHING', 'END', 'KEEP']);
  for (const bad of ['coaching', 'DELETE', '', null, 3]) assert.ok(!isPromotionChoice(bad));
  assert.equal(PROMOTION_END_REASON, 'changed_goals');
});

test('open relations need a choice; no default is ever assumed', () => {
  assert.deepEqual(checkPromotionChoice(1, undefined), { ok: false, code: 'promotion_choice_required' });
  assert.deepEqual(checkPromotionChoice(2, null), { ok: false, code: 'promotion_choice_required' });
  for (const choice of PROMOTION_CHOICES) assert.deepEqual(checkPromotionChoice(1, choice), { ok: true, choice });
});

test('a malformed choice is refused even with nothing open; with nothing open a valid one is ignored', () => {
  assert.deepEqual(checkPromotionChoice(0, 'DELETE'), { ok: false, code: 'invalid_promotion_choice' });
  assert.deepEqual(checkPromotionChoice(1, 'DELETE'), { ok: false, code: 'invalid_promotion_choice' });
  assert.deepEqual(checkPromotionChoice(0, undefined), { ok: true, choice: null });
  assert.deepEqual(checkPromotionChoice(0, 'END'), { ok: true, choice: null });
});
