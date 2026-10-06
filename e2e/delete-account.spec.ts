import { test, expect } from '@playwright/test';

// The public account-deletion page (docs/mobile-strategy.md). Google Play needs
// a URL that explains deletion without the app, so the page must render for a
// signed-out visitor, be reachable from the privacy notice, and lead into the
// real in-app path — /account, back there after sign-in.

test('privacy notice links to the deletion page, which explains the in-app path', async ({ page }) => {
  await page.goto('/privacy');
  await page.getByTestId('privacy-delete-account-link').click();
  await expect(page).toHaveURL(/\/delete-account$/);
  await expect(page.getByRole('heading', { name: 'Delete your account', level: 1 })).toBeVisible();
  await expect(page.getByTestId('delete-account-steps').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('delete-account-no-access')).not.toBeEmpty();
});

test('the call to action lands a signed-out visitor on sign-in, aimed back at /account', async ({ page }) => {
  await page.goto('/delete-account');
  await page.getByTestId('delete-account-cta').click();
  await expect(page).toHaveURL(/\/auth\/signin\?callbackUrl=(%2F|\/)account/);
});
