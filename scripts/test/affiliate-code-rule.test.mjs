// Unit tests for the partner code's shape (src/lib/affiliateCodeRule.ts, #3550)
// and that every place that recognises a code reads that one rule.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { PARTNER_CODE_RE, PARTNER_CODE_MAX, isPartnerCode, codeFromPath } = await import('../../src/lib/affiliateCodeRule.ts');

test('old-system user names with . and @ are codes; a leading letter or digit, nothing else', () => {
  for (const ok of ['partner.name', 'ada@example', 'a.b-c_1', 'K_1', 'demo-partner', '7', 'x'.repeat(PARTNER_CODE_MAX)]) {
    assert.equal(isPartnerCode(ok), true, ok);
  }
  for (const bad of ['.ada', '@ada', '-x', 'a b', 'ada/x', 'ada?x', 'ada#x', 'ada&x', 'ada%40x', 'x'.repeat(PARTNER_CODE_MAX + 1), '', ' ', null, 7]) {
    assert.equal(isPartnerCode(bad), false, String(bad));
  }
});

test('a code from a path is decoded once: %40 and @ are the same code', () => {
  assert.equal(codeFromPath('ada%40example'), 'ada@example');
  assert.equal(codeFromPath('ada@example'), 'ada@example');
  assert.equal(codeFromPath('plain'), 'plain');
  // A malformed escape comes back as it was, and is then no code.
  assert.equal(codeFromPath('ada%E0%A4%A'), 'ada%E0%A4%A');
  assert.equal(isPartnerCode(codeFromPath('ada%E0%A4%A')), false);
});

test('no copy of the rule is left: the page, the click link and the migration read the same one', async () => {
  const { REFERRAL_CODE_RE } = await import('../../src/lib/affiliateLandingRule.ts');
  const { CLICK_CODE_RE, clickRedirectTarget } = await import('../../src/lib/affiliateClickRule.ts');
  assert.equal(REFERRAL_CODE_RE, PARTNER_CODE_RE);
  assert.equal(CLICK_CODE_RE, PARTNER_CODE_RE);
  // A link carries @ percent-encoded in the query.
  assert.equal(clickRedirectTarget('https://app.acme.example/register', 'ada@example'), 'https://app.acme.example/register?ref=ada%40example');

  const { readFileSync, readdirSync } = await import('node:fs');
  // Nothing in src/lib spells the old or the new shape out a second time.
  const dir = new URL('../../src/lib/', import.meta.url);
  const copies = readdirSync(dir)
    .filter((f) => f.startsWith('affiliate') && f.endsWith('.ts') && f !== 'affiliateCodeRule.ts')
    .filter((f) => /\[A-Za-z0-9\]\[A-Za-z0-9[._@-]*\]/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(copies, []);
});

test('the migration keeps . and @ and names a code with a space as needing a new one', async () => {
  const { parseDelimited } = await import('../../src/lib/importPreview.ts');
  const { readPartners } = await import('../../src/lib/affiliateMigrationRule.ts');
  const header = 'code,name,paid_total,unpaid_total';
  const csv = [header, 'ada@example,Ada,0,0', 'max.muster,Max,0,0', 'old name,Old,0,0'].join('\n');
  const { partners, issues } = readPartners(parseDelimited(csv));
  assert.deepEqual(partners.map((p) => p.code), ['ada@example', 'max.muster']);
  assert.deepEqual(issues.map((i) => [i.row, i.code]), [[3, 'code_needs_new']]);
});
