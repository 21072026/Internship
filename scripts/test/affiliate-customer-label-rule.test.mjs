// Unit tests for the partner-facing customer label (src/lib/affiliateCustomerLabelRule.ts,
// docs/affiliate-module.md, #3352). Synthetic names only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomerLabel, CUSTOMER_LABEL_MAX } from '../../src/lib/affiliateCustomerLabelRule.ts';

test('a label is trimmed and its whitespace collapsed', () => {
  assert.equal(parseCustomerLabel('  Acme\n  GmbH '), 'Acme GmbH');
});

test('null, an empty or a blank string clear the label', () => {
  for (const raw of [null, '', '   ']) assert.equal(parseCustomerLabel(raw), null, JSON.stringify(raw));
});

test('anything else is refused, and so is a label over the limit', () => {
  for (const raw of [undefined, 42, {}, ['Acme']]) assert.equal(parseCustomerLabel(raw), undefined, JSON.stringify(raw));
  assert.equal(parseCustomerLabel('x'.repeat(CUSTOMER_LABEL_MAX)), 'x'.repeat(CUSTOMER_LABEL_MAX));
  assert.equal(parseCustomerLabel('x'.repeat(CUSTOMER_LABEL_MAX + 1)), undefined);
});
