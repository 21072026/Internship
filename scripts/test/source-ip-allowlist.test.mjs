// Unit tests for src/lib/sourceIpAllowlistRule.ts — the IP allowlist of a
// registered integration source (#2978): parsing and canonical spelling of IPv4
// / IPv6 addresses and CIDR blocks, the refusals, CIDR matching in both
// families, fail-closed reads — and the plain-ESM mirror the operator CLI
// carries (prisma/register-integration-source.mjs), compared on one corpus.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rule = await import('../../src/lib/sourceIpAllowlistRule.ts');
const mirror = await import('../../prisma/register-integration-source.mjs');

const canon = (raw) => {
  const r = rule.parseAllowlistEntry(raw);
  return r.ok ? r.entry.text : r.code;
};

test('IPv4 addresses and blocks, canonical', () => {
  assert.equal(canon('203.0.113.7'), '203.0.113.7');
  assert.equal(canon(' 203.0.113.7 '), '203.0.113.7');
  assert.equal(canon('203.0.113.7/32'), '203.0.113.7');
  assert.equal(canon('198.51.100.0/24'), '198.51.100.0/24');
  assert.equal(canon('10.0.0.0/8'), '10.0.0.0/8');
  assert.equal(canon('0.0.0.0/1'), '0.0.0.0/1');
});

test('IPv6 addresses and blocks, RFC 5952 canonical', () => {
  assert.equal(canon('2001:DB8::1'), '2001:db8::1');
  assert.equal(canon('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.equal(canon('2001:db8:0:0:1:0:0:1'), '2001:db8::1:0:0:1'); // first of two equal runs
  assert.equal(canon('2001:db8:0:1:1:1:1:1'), '2001:db8:0:1:1:1:1:1'); // a single zero group stays
  assert.equal(canon('2001:db8::/32'), '2001:db8::/32');
  assert.equal(canon('[2001:db8::1]'), '2001:db8::1');
  assert.equal(canon('::1'), '::1');
  assert.equal(canon('fe80::/10'), 'fe80::/10');
  assert.equal(canon('2001:db8::1/128'), '2001:db8::1');
});

test('IPv4-mapped IPv6 is the IPv4 address it carries', () => {
  assert.equal(canon('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(canon('::ffff:cb00:7107'), '203.0.113.7');
  assert.equal(canon('::ffff:198.51.100.0/120'), '198.51.100.0/24');
  assert.equal(canon('::ffff:198.51.100.0/95'), 'invalid');
});

test('refusals: not an address, host bits, /0', () => {
  for (const bad of ['', 'localhost', '203.0.113', '203.0.113.256', '203.0.113.07', '203.0.113.7/33', '203.0.113.7/-1', '203.0.113.0/2a',
    '2001:db8:::1', '2001:db8::1::2', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', '2001:db8::g', 'fe80::1%eth0', '2001:db8::/129', '1.2.3.4::', '12345::1']) {
    assert.equal(canon(bad), 'invalid', bad);
  }
  assert.equal(canon('10.0.0.1/8'), 'host_bits');
  assert.equal(canon('2001:db8::1/32'), 'host_bits');
  assert.equal(canon('0.0.0.0/0'), 'too_broad');
  assert.equal(canon('::/0'), 'too_broad');
});

test('a list: separators, de-duplication, every error reported, the cap', () => {
  const r = rule.parseAllowlist('203.0.113.7, 198.51.100.0/24\n2001:db8::/32;203.0.113.7/32  nope 10.0.0.1/8');
  assert.deepEqual(r.entries.map((e) => e.text), ['203.0.113.7', '198.51.100.0/24', '2001:db8::/32']);
  assert.deepEqual(r.errors, [{ value: 'nope', code: 'invalid' }, { value: '10.0.0.1/8', code: 'host_bits' }]);
  assert.deepEqual(rule.parseAllowlist(['203.0.113.7', ' ']).entries.map((e) => e.text), ['203.0.113.7']);
  assert.deepEqual(rule.parseAllowlist(null), { entries: [], errors: [] });
  assert.deepEqual(rule.parseAllowlist(''), { entries: [], errors: [] });
  const many = Array.from({ length: rule.SOURCE_ALLOWLIST_MAX + 1 }, (_, i) => `10.0.${i}.0/24`);
  assert.deepEqual(rule.parseAllowlist(many).errors, [{ value: String(rule.SOURCE_ALLOWLIST_MAX + 1), code: 'too_many' }]);
  assert.deepEqual(rule.parseAllowlist(many.slice(0, rule.SOURCE_ALLOWLIST_MAX)).errors, []);
});

test('stored text round-trips, and an unreadable store fails closed', () => {
  const entries = rule.parseAllowlist('203.0.113.7 2001:db8::/32').entries;
  const stored = rule.serializeAllowlist(entries);
  assert.equal(stored, '203.0.113.7,2001:db8::/32');
  assert.deepEqual(rule.allowlistTexts(stored), ['203.0.113.7', '2001:db8::/32']);
  assert.equal(rule.serializeAllowlist([]), null);
  assert.equal(rule.storedAllowlist(null), null);
  assert.equal(rule.storedAllowlist(''), null);
  // A list is set, but nothing in it parses: it matches nobody — never "anyone".
  const broken = rule.storedAllowlist('garbage');
  assert.deepEqual(broken, []);
  assert.equal(rule.ipInAllowlist('203.0.113.7', broken), false);
});

test('CIDR matching, IPv4', () => {
  const list = rule.parseAllowlist('203.0.113.7, 198.51.100.0/24, 10.0.0.0/8').entries;
  for (const ip of ['203.0.113.7', '198.51.100.0', '198.51.100.255', '10.255.255.255', '10.0.0.1', '::ffff:198.51.100.9']) {
    assert.equal(rule.ipInAllowlist(ip, list), true, ip);
  }
  for (const ip of ['203.0.113.8', '198.51.101.0', '11.0.0.0', '9.255.255.255', 'unknown', '', null, '::1', '2001:db8::1']) {
    assert.equal(rule.ipInAllowlist(ip, list), false, String(ip));
  }
});

test('CIDR matching, IPv6', () => {
  const list = rule.parseAllowlist('2001:db8::/32, 2001:db8:ffff::1, fe80::/10').entries;
  for (const ip of ['2001:db8::1', '2001:0db8:1234::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', 'fe80::1', 'febf::1', '[2001:db8::5]']) {
    assert.equal(rule.ipInAllowlist(ip, list), true, ip);
  }
  for (const ip of ['2001:db9::', '2001:db7:ffff::', 'fec0::1', '203.0.113.7', '::ffff:203.0.113.7']) {
    assert.equal(rule.ipInAllowlist(ip, list), false, ip);
  }
});

test('an IPv4 list never matches an IPv6 client and the reverse', () => {
  assert.equal(rule.ipInAllowlist('::1', rule.parseAllowlist('0.0.0.0/1, 128.0.0.0/1').entries), false);
  assert.equal(rule.ipInAllowlist('203.0.113.7', rule.parseAllowlist('::/1, 8000::/1').entries), false);
});

// ── The CLI mirror ─────────────────────────────────────────────────────────

const CORPUS = [
  '203.0.113.7', '203.0.113.7/32', '198.51.100.0/24', ' 10.0.0.0/8 ', '0.0.0.0/1', '0.0.0.0/0', '10.0.0.1/8',
  '203.0.113.256', '203.0.113.07', '203.0.113', '2001:DB8::1', '2001:0db8:0000:0000:0000:0000:0000:0001',
  '2001:db8:0:0:1:0:0:1', '2001:db8::/32', '2001:db8::1/32', '::/0', '::1', '::', '[2001:db8::1]', 'fe80::1%eth0',
  '::ffff:203.0.113.7', '::ffff:198.51.100.0/120', '::ffff:198.51.100.0/95', '1.2.3.4::', '2001:db8:::1', 'nope', '',
  '203.0.113.7, 198.51.100.0/24\n2001:db8::/32;203.0.113.7/32 nope',
];

test('the CLI mirror agrees with the rule on every corpus entry', () => {
  for (const raw of CORPUS) {
    const a = rule.parseAllowlist(raw);
    const b = mirror.parseAllowlist(raw);
    assert.deepEqual(b.entries.map((e) => e.text), a.entries.map((e) => e.text), raw);
    assert.deepEqual(b.errors, a.errors, raw);
    assert.equal(mirror.serializeAllowlist(b.entries), rule.serializeAllowlist(a.entries), raw);
  }
  const many = Array.from({ length: rule.SOURCE_ALLOWLIST_MAX + 1 }, (_, i) => `10.0.${i}.0/24`);
  assert.deepEqual(mirror.parseAllowlist(many).errors, rule.parseAllowlist(many).errors);
  assert.equal(mirror.SOURCE_ALLOWLIST_MAX, rule.SOURCE_ALLOWLIST_MAX);
});
