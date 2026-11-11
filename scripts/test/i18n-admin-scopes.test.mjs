// The admin area ships its dictionary per section (#3599).
//
// `admin` used to be one scope: the union of every admin screen, 220
// namespaces, ~600 KB of HTML on each admin page. It is now the admin CHROME
// (layout, error, loading), plus one `admin/<section>` scope per sub-directory
// and `admin/index` for the dashboard. These tests pin the two things that keep
// it that way: the chrome stays free of section namespaces, and the
// `i18n-scopes: no-dictionary` opt-out cannot be put on a file that reads the
// dictionary.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function scopes() {
  execFileSync(process.execPath, ['scripts/i18n-scopes.mjs'], { stdio: 'pipe' });
  const generated = readFileSync('src/i18n/scopes.generated.ts', 'utf8');
  const out = {};
  for (const m of generated.matchAll(/^ {2}'([^']+)': (\[[^\]]*\]|\[\])/gm)) out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  return out;
}

test('admin is split into a chrome scope and one scope per section', () => {
  const s = scopes();
  assert.ok(s.admin, 'the admin chrome scope is missing');
  for (const id of ['admin/index', 'admin/candidates', 'admin/settings', 'admin/duplicates']) assert.ok(s[id], `${id} is missing`);
  // A section's namespaces never repeat the chrome's: it renders inside it.
  for (const n of s['admin/candidates']) assert.ok(!s.admin.includes(n), `admin/candidates repeats chrome namespace ${n}`);
});

test('the admin chrome does not carry section-only namespaces', () => {
  const chrome = scopes().admin;
  // Each of these was pulled into the chrome by a nav key or a permission name
  // (`key: 'settings'`, `'org.settings.write'`), not by a read.
  for (const ns of ['settings', 'organizations', 'integrations', 'billing']) {
    assert.ok(!chrome.includes(ns), `the admin chrome ships \`${ns}\` again — run \`node scripts/i18n-scopes.mjs --why=${ns} --scope=admin\``);
  }
});

test('a file marked no-dictionary that reads the dictionary fails the scan', () => {
  // A copy of the scanner's inputs, with one admin-chrome file that lies.
  const dir = mkdtempSync(path.join(tmpdir(), 'i18n-scopes-'));
  try {
    cpSync('src', path.join(dir, 'src'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts'));
    cpSync('scripts/i18n-scopes.mjs', path.join(dir, 'scripts/i18n-scopes.mjs'));
    const liar = path.join(dir, 'src/lib/navLinks.ts');
    writeFileSync(liar, readFileSync(liar, 'utf8') + "\nimport { useT } from '@/i18n/client';\nexport const x = () => useT();\n");
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts/i18n-scopes.mjs')], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'the scan accepted a no-dictionary file that calls useT()');
    assert.match(r.stderr, /navLinks\.ts is marked "i18n-scopes: no-dictionary" but reads the dictionary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
