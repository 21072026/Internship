import { test, expect } from '@playwright/test';

/**
 * E2E tests for Product-Led Growth (PLG) Interactive Demo Mode & CTA buttons.
 */

test('demo page loads cleanly and allows role tab switching', { tag: '@smoke' }, async ({ page }) => {
  const res = await page.goto('/demo');
  expect(res?.status() ?? 0).toBeLessThan(400);

  // Verify header and badge
  await expect(page.locator('text=Uygulamayı Canlı Görün')).toBeVisible();
  await expect(page.locator('text=Admin Paneli')).toBeVisible();

  // Switch to Mentor perspective
  await page.click('button:has-text("Mentör Portalı")');
  await expect(page.locator('text=Mentör Portalı Simülatörü')).toBeVisible();

  // Switch to Mentee perspective
  await page.click('button:has-text("Menti Portalı")');
  await expect(page.locator('text=Menti Portalı & Yol Haritası')).toBeVisible();

  // Switch to Company perspective
  await page.click('button:has-text("Şirket Paneli")');
  await expect(page.locator('text=Şirket Yetenek Havuzu Paneli')).toBeVisible();
});

test('landing page hero contains demo button linking to /demo', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/');
  const demoBtn = page.locator('a[href="/demo"]').first();
  await expect(demoBtn).toBeVisible();
  await demoBtn.click();
  await page.waitForURL('**/demo');
});
