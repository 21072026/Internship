// Unit tests for the payout-details rule (src/lib/payoutDetailsRule.ts, #3115).
//
// Run: npm run test:unit
//
// The IBANs are the published ISO 13616 / bank-documentation EXAMPLES (no real
// person's account), each with a one-digit typo twin that the mod-97 check catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIban, isValidIban, parsePayoutDetails, maskIban, HOLDER_MAX_CHARS } from '../../src/lib/payoutDetailsRule.ts';

const EXAMPLES = ['DE89 3704 0044 0532 0130 00', 'GB82 WEST 1234 5698 7654 32', 'TR33 0006 1005 1978 6457 8413 26', 'NL91ABNA0417164300'];

test('published example IBANs pass, in any spacing or case', () => {
  for (const iban of EXAMPLES) assert.equal(isValidIban(iban), true, iban);
  assert.equal(isValidIban('de89-3704-0044-0532-0130-00'), true);
  assert.equal(normalizeIban(' de89 3704 0044 0532 0130 00 '), 'DE89370400440532013000');
});

test('a one-digit typo, a wrong shape or garbage fails', () => {
  assert.equal(isValidIban('DE89 3704 0044 0532 0130 01'), false); // last digit changed
  assert.equal(isValidIban('DE98 3704 0044 0532 0130 00'), false); // check digits swapped
  for (const bad of ['', 'DE89', '1289370400440532013000', 'DE8937040044053201300!', 'X'.repeat(40)]) assert.equal(isValidIban(bad), false, bad);
});

test('payout details: normalised IBAN, trimmed holder, every problem named', () => {
  assert.deepEqual(parsePayoutDetails({ iban: 'de89 3704 0044 0532 0130 00', holder: '  Jane   Example ' }), {
    ok: true,
    details: { iban: 'DE89370400440532013000', holder: 'Jane Example' },
  });
  assert.deepEqual(parsePayoutDetails({ iban: 'DE00', holder: '' }), { ok: false, issues: ['iban', 'holder'] });
  assert.deepEqual(parsePayoutDetails({ iban: EXAMPLES[0], holder: 'x'.repeat(HOLDER_MAX_CHARS + 1) }), { ok: false, issues: ['holder'] });
  assert.equal(parsePayoutDetails(null).ok, false);
});

test('the mask shows the last four characters only', () => {
  assert.equal(maskIban('DE89370400440532013000'), '•••• 3000');
  assert.equal(maskIban('de89 3704 0044 0532 0130 00'), '•••• 3000');
  assert.equal(maskIban('AB'), '••••');
});
