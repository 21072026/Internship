// Unit tests for affiliate payout details (docs/affiliate-module.md, decisions 9-10).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIban,
  isValidIban,
  encodePayoutDetails,
  decodePayoutDetails,
} from '../../src/lib/affiliatePayoutDetails.ts';

test('the standard German and British examples are valid', () => {
  assert.equal(isValidIban('DE89370400440532013000'), true);
  assert.equal(isValidIban('GB82 WEST 1234 5698 7654 32'), true, 'spaces are allowed');
});

test('a single wrong digit fails the mod-97 check', () => {
  assert.equal(isValidIban('DE89370400440532013001'), false);
});

test('wrong shape is refused before the checksum', () => {
  assert.equal(isValidIban(''), false);
  assert.equal(isValidIban('12DE89370400440532013000'), false, 'country code must lead');
  assert.equal(isValidIban('DE89'), false, 'too short');
  assert.equal(isValidIban('DE89-3704-0044-0532-0130-00'), false, 'punctuation is not allowed');
});

test('normalise upper-cases and strips whitespace', () => {
  assert.equal(normalizeIban(' de89 3704 0044  '), 'DE8937040044');
});

test('encode then decode round-trips, with the holder trimmed and the IBAN normalised', () => {
  const sealed = encodePayoutDetails({ accountHolder: '  Ada Lovelace ', iban: 'de89 3704 0044 0532 0130 00' });
  assert.deepEqual(decodePayoutDetails(sealed), {
    accountHolder: 'Ada Lovelace',
    iban: 'DE89370400440532013000',
  });
});

test('a stored value of another shape decodes to null, not to a partial object', () => {
  assert.equal(decodePayoutDetails('not json'), null);
  assert.equal(decodePayoutDetails('null'), null);
  assert.equal(decodePayoutDetails('{"iban":"DE89"}'), null);
});
