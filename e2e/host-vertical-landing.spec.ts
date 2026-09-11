import { test, expect } from '@playwright/test';

// Host → vertical landing (#2355, epic #2348). Two urls serve two products'
// landing copy from one deployment: interncrm.com (default) shows the internship
// hero, marketing.ersah.in the marketing one. The signal on a public, sessionless
// page is the request host (x-forwarded-host, set by the reverse proxy). The
// default MARKETING_HOSTS is 'marketing.ersah.in', so forging that header routes
// the marketing overlay without any env change.

test('the default host shows the internship hero — a no-op for the current product', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Companies that want experience', { exact: false })).toBeVisible();
  // The marketing pitch is absent.
  await expect(page.getByText('Every lead, every conversation', { exact: false })).toHaveCount(0);
});

test('the marketing host shows the marketing hero', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': 'marketing.ersah.in' });
  await page.goto('/');
  await expect(page.getByText('Every lead, every conversation', { exact: false })).toBeVisible();
  await expect(page.getByText('Marketing CRM · Track leads', { exact: false })).toBeVisible();
  // The internship hero is gone.
  await expect(page.getByText('Companies that want experience', { exact: false })).toHaveCount(0);
});

test('an unknown host falls back to the internship hero, never a blank one', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': 'random.example.com' });
  await page.goto('/');
  await expect(page.getByText('Companies that want experience', { exact: false })).toBeVisible();
});
