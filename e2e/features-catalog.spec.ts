import { test, expect } from '@playwright/test';

// #584/#587/#588: the /features catalogue and the landing cards share one data
// source. The landing keeps its exact featured strings (asserted elsewhere)
// and links to the catalogue from header, grid and footer.
test('features catalogue renders categorized entries and landing links to it', async ({ page }) => {
  await page.goto('/features');
  await expect(page.getByRole('heading', { name: 'Everything InternshipCRM can do' })).toBeVisible();
  // A featured landing string and a catalogue-only entry both render.
  await expect(page.getByText('Pipeline tracking', { exact: true })).toBeVisible();
  await expect(page.getByText('Built-in messaging', { exact: true })).toBeVisible();
  // Categories exist.
  await expect(page.getByTestId('feature-cat-collaboration')).toBeVisible();
  await expect(page.getByTestId('feature-cat-insights')).toBeVisible();

  // Landing links to the catalogue (grid CTA), and the cards still render.
  await page.goto('/');
  await expect(page.getByText('Pipeline tracking', { exact: true })).toBeVisible();
  await page.getByTestId('all-features-link').click();
  await page.waitForURL('**/features');
  await expect(page.getByRole('heading', { name: 'Everything InternshipCRM can do' })).toBeVisible();
});
