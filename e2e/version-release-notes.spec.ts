import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';

const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

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
