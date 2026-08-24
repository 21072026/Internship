import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';

const repoRoot = path.join(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
// The footer shows the DERIVED version: base plus pending release fragments
// (#1275) — compute the expectation with the same code next.config.js uses.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const release = require(path.join(repoRoot, 'scripts', 'release-derive.cjs'));
pkg.version = release.deriveVersion(pkg.version, release.readFragments(repoRoot));

test('landing footer shows the app version linking to release notes', async ({ page }) => {
  await page.goto('/');
  const link = page.getByRole('link', { name: new RegExp(`^v${pkg.version.replace(/\./g, '\\.')}`) });
  await expect(link).toBeVisible();
  await link.click();
  await page.waitForURL('**/release-notes');
  await expect(page.getByRole('heading', { name: /What.s new|Yenilikler|Neuigkeiten/ })).toBeVisible();
  // Latest entry matches the running package.json version.
  await expect(page.getByRole('heading', { name: `v${pkg.version}` })).toBeVisible();
});
