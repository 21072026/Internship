// The sign-in pages ship only the dictionary namespaces they render (#2707).
//
// /auth/signin is one of the three paths the weekly stress test hammers, and it
// used to carry `account` (11.6 KB) and `mentor` (4.9 KB) for one shared key and
// one role literal. The scope scan is over-inclusive by design
// (scripts/i18n-scopes.mjs), so a stray `'mentor'` or `t.account.…` anywhere in
// the auth client graph silently puts them back. This test says so when it does.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('the auth scope carries neither `account` nor `mentor`', () => {
  execFileSync(process.execPath, ['scripts/i18n-scopes.mjs'], { stdio: 'pipe' });
  const generated = readFileSync('src/i18n/scopes.generated.ts', 'utf8');
  const block = /'auth': \[([^\]]*)\]/.exec(generated);
  assert.ok(block, 'the auth scope is missing from scopes.generated.ts');
  const namespaces = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(namespaces.includes('auth'), `auth scope: ${namespaces.join(', ')}`);
  for (const heavy of ['account', 'mentor']) {
    assert.ok(!namespaces.includes(heavy), `the auth scope ships \`${heavy}\` again — run \`node scripts/i18n-scopes.mjs --why=${heavy} --scope=auth\``);
  }
});
