import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';

const repoRoot = path.join(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
// The footer shows the DERIVED version: the base plus one bump per pending
// release fragment (#1275), each fragment being its own release (#1457).
// Compute the expectation with the same code next.config.js uses.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const release = require(path.join(repoRoot, 'scripts', 'release-derive.cjs'));
const { version, timeline } = release.resolveRelease(repoRoot, pkg.version);
// /release-notes lists one entry per change that carries user-facing notes, so
// its newest heading is the newest NOTED release — which is the app version
// only when the latest change was user-visible.
const newestNoted = [...timeline].reverse().find((entry: { notes?: unknown }) => entry.notes);
const topEntryVersion: string = newestNoted ? newestNoted.version : pkg.version;

test('landing footer shows the app version linking to release notes', async ({ page }) => {
  await page.goto('/');
  const link = page.getByRole('link', { name: new RegExp(`^v${version.replace(/\./g, '\\.')}`) });
  await expect(link).toBeVisible();
  await link.click();
  await page.waitForURL('**/release-notes');
  await expect(page.getByRole('heading', { name: /What.s new|Yenilikler|Neuigkeiten/ })).toBeVisible();
  // Newest entry on the page is the newest user-visible release.
  await expect(page.getByRole('heading', { name: `v${topEntryVersion}` })).toBeVisible();
});
