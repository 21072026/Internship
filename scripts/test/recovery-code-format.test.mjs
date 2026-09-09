// Unit tests for the 2FA recovery-code FORMAT (#1542).
//
// Run: npm run test:recovery-codes  (node --test --experimental-strip-types)
//
// WHAT THIS PINS THAT NOTHING ELSE CAN
//   The hash stored in the database is taken over the NORMALISED code, so
//   `normalizeRecoveryCode` is part of the credential: a change to it silently
//   invalidates every code every user has on paper, and nothing else in the
//   tree would fail. The e2e spec cannot catch that either — it mints and
//   spends codes inside one run, where both halves have moved together.
//
//   The other two properties are the ones a reviewer would have to take on
//   trust: that the alphabet really excludes the confusable characters (a
//   misread code is a code that silently does not work, on the worst possible
//   day), and that a 6-digit TOTP code can never be mistaken for a recovery
//   code — because that decision is what routes an attempt into the recovery
//   failure bucket rather than the authenticator's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  codeFromBytes,
  formatRecoveryCode,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
} from '../../src/lib/recoveryCodeFormat.ts';

test('the alphabet excludes every confusable character', () => {
  for (const ch of ['0', 'o', '1', 'l', 'i', '5', 's', '2', 'z']) {
    assert.equal(RECOVERY_CODE_ALPHABET.includes(ch), false, `${ch} must not be in the alphabet`);
  }
  // Lowercase only, no duplicates — normalisation lowercases, so an uppercase
  // entry would be unreachable and a duplicate would skew the distribution.
  assert.equal(RECOVERY_CODE_ALPHABET, RECOVERY_CODE_ALPHABET.toLowerCase());
  assert.equal(new Set(RECOVERY_CODE_ALPHABET).size, RECOVERY_CODE_ALPHABET.length);
});

test('normalisation makes the presentation irrelevant', () => {
  // The dash is cosmetic; case, spaces and a trailing newline are not part of
  // the credential. All four spellings must hash to the same thing.
  const spellings = ['abcd-efgh', 'abcdefgh', 'ABCD-EFGH', '  abcd efgh\n'];
  for (const spelling of spellings) {
    assert.equal(normalizeRecoveryCode(spelling), 'abcdefgh', spelling);
  }
});

test('normalisation drops anything outside the alphabet', () => {
  assert.equal(normalizeRecoveryCode('a!b@c#d$e%f^g&h'), 'abcdefgh');
  assert.equal(normalizeRecoveryCode(''), '');
  // Every character here is a confusable the alphabet deliberately excludes.
  assert.equal(normalizeRecoveryCode('0125ILOSZ'), '');
});

test('a TOTP code is never read as a recovery code', () => {
  // The whole point of the shape test: an authenticator code must be charged
  // to the TOTP bucket, never to the recovery one.
  for (const code of ['123456', '000000', '999999', '654 321']) {
    assert.equal(looksLikeRecoveryCode(code), false, code);
  }
  assert.equal(looksLikeRecoveryCode('abcd-efgh'), true);
  assert.equal(looksLikeRecoveryCode('abcdefgh'), true);
  // Wrong length either way is not a recovery code.
  assert.equal(looksLikeRecoveryCode('abcdefg'), false);
  assert.equal(looksLikeRecoveryCode('abcdefghj'), false);
});

test('minting maps bytes onto the alphabet, at the declared length', () => {
  const code = codeFromBytes([0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(code.length, RECOVERY_CODE_LENGTH);
  assert.equal(code, RECOVERY_CODE_ALPHABET.slice(0, 8));
  // Every byte value lands inside the alphabet, so no code can carry a
  // character normalisation would then strip.
  for (let b = 0; b < 256; b++) {
    const c = codeFromBytes(new Array(RECOVERY_CODE_LENGTH).fill(b));
    assert.equal(normalizeRecoveryCode(c), c, `byte ${b}`);
    assert.equal(looksLikeRecoveryCode(c), true, `byte ${b}`);
  }
});

test('minting refuses to run short of randomness', () => {
  // Silently padding or wrapping would produce a code with less entropy than
  // the format promises, which is exactly the failure nobody would notice.
  assert.throws(() => codeFromBytes([1, 2, 3]), /at least/);
});

test('formatting is display-only and round-trips through normalisation', () => {
  assert.equal(formatRecoveryCode('abcdefgh'), 'abcd-efgh');
  assert.equal(normalizeRecoveryCode(formatRecoveryCode('abcdefgh')), 'abcdefgh');
  // Short input is left alone rather than gaining a trailing dash.
  assert.equal(formatRecoveryCode('abc'), 'abc');
});

test('a set is ten codes', () => {
  // Pinned because it is a published property: the account page shows
  // "remaining / total" and the docs say ten.
  assert.equal(RECOVERY_CODE_COUNT, 10);
});
