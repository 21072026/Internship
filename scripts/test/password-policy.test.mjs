// Unit tests for src/lib/passwordPolicyRule.ts (#1544): the settings → policy
// parse with its floor, the rule check, and the HIBP k-anonymity helpers.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const rule = await import('../../src/lib/passwordPolicyRule.ts');

test('the default policy is the rule the app always had: 8 chars, one upper, one lower', () => {
  assert.deepEqual(rule.parsePasswordPolicy({}), { minLength: 8, requireUpper: true, requireLower: true, requireDigit: false, requireSymbol: false });
  assert.deepEqual(rule.passwordRules(rule.DEFAULT_PASSWORD_POLICY), ['min_length', 'upper', 'lower']);
});

test('settings are parsed as stored strings; the minimum length is clamped and never weaker than the floor', () => {
  const p = rule.parsePasswordPolicy({ passwordMinLength: '12', passwordRequireDigit: 'true', passwordRequireUpper: 'false', passwordRequireSymbol: 'nonsense' });
  assert.deepEqual(p, { minLength: 12, requireUpper: false, requireLower: true, requireDigit: true, requireSymbol: false });
  assert.equal(rule.parsePasswordPolicy({ passwordMinLength: '3' }).minLength, 8, 'a stored 3 reads as the floor');
  assert.equal(rule.parsePasswordPolicy({ passwordMinLength: '999' }).minLength, 128, 'capped at the ceiling');
  assert.equal(rule.parsePasswordPolicy({ passwordMinLength: 'abc' }).minLength, 8, 'garbage falls back to the default');
  assert.equal(rule.isStorableMinLength('8'), true);
  assert.equal(rule.isStorableMinLength('128'), true);
  assert.equal(rule.isStorableMinLength('7'), false);
  assert.equal(rule.isStorableMinLength('129'), false);
  assert.equal(rule.isStorableMinLength('1e2'), false);
});

test('failed rules come back in display order, and only the rules the policy imposes', () => {
  const d = rule.DEFAULT_PASSWORD_POLICY;
  assert.deepEqual(rule.failedPasswordRules('Password1', d), []);
  assert.deepEqual(rule.failedPasswordRules('weakpass', d), ['upper']);
  assert.deepEqual(rule.failedPasswordRules('WEAKPASS', d), ['lower']);
  assert.deepEqual(rule.failedPasswordRules('Ab1', d), ['min_length']);
  assert.deepEqual(rule.failedPasswordRules('abc', d), ['min_length', 'upper']);
  const strict = { minLength: 12, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: true };
  assert.deepEqual(rule.failedPasswordRules('Password1234', strict), ['symbol']);
  assert.deepEqual(rule.failedPasswordRules('Correct-Horse-Battery', strict), ['digit']);
  assert.deepEqual(rule.failedPasswordRules('Correct-Horse-Battery-9', strict), []);
  // A policy that imposes no digit rule never fails on digits.
  assert.deepEqual(rule.failedPasswordRules('Password', { ...d, requireDigit: false }), []);
});

test('letters are Unicode-aware: a Turkish or German upper-case letter counts', () => {
  const d = rule.DEFAULT_PASSWORD_POLICY;
  assert.deepEqual(rule.failedPasswordRules('şifrelerim', d), ['upper']);
  assert.deepEqual(rule.failedPasswordRules('Şifrelerim', d), []);
  assert.deepEqual(rule.failedPasswordRules('überlängeÄ', d), []);
  // Length counts code points, not UTF-16 units.
  assert.deepEqual(rule.failedPasswordRules('Ab😀😀😀😀😀', { ...d, minLength: 8 }), ['min_length']);
  assert.deepEqual(rule.failedPasswordRules('Ab😀😀😀😀😀😀', { ...d, minLength: 8 }), []);
});

test('each rule has a sentence, and the length one carries the number', () => {
  const p = { ...rule.DEFAULT_PASSWORD_POLICY, minLength: 14 };
  assert.equal(rule.describePasswordRule('min_length', p), 'Password must be at least 14 characters');
  for (const id of ['upper', 'lower', 'digit', 'symbol']) assert.match(rule.describePasswordRule(id, p), /^Password must include /);
});

test('only five hex characters of the SHA-1 are the prefix; the suffix stays local', () => {
  const sha = createHash('sha1').update('Password123', 'utf8').digest('hex').toUpperCase();
  const { prefix, suffix } = rule.splitSha1(sha);
  assert.equal(prefix.length, 5);
  assert.equal(suffix.length, 35);
  assert.equal(prefix + suffix, sha);
  assert.throws(() => rule.splitSha1('abc'), /40-character/);
});

test('the range body is matched locally; padding lines (count 0) are not breaches; CRLF and case are tolerated', () => {
  const sha = createHash('sha1').update('Password123', 'utf8').digest('hex').toUpperCase();
  const { suffix } = rule.splitSha1(sha);
  const body = `0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${suffix}:1234567\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0\r\n`;
  assert.equal(rule.matchHibpRange(body, suffix), 1234567);
  assert.equal(rule.matchHibpRange(body, suffix.toLowerCase()), 1234567);
  assert.equal(rule.matchHibpRange(body, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'), 0, 'a padding line is not a breach');
  assert.equal(rule.matchHibpRange(body, '0000000000000000000000000000000000A'), 0);
  assert.equal(rule.matchHibpRange('', suffix), 0);
  assert.equal(rule.matchHibpRange('garbage without separators', suffix), 0);
});
