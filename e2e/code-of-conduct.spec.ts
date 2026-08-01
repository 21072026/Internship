import { test, expect } from '@playwright/test';

// The public code of conduct: reachable from the landing footer and translated
// into all three locales (the repo version lives in CODE_OF_CONDUCT.md).

test('landing footer links to the code of conduct', async ({ page }) => {
  await page.goto('/');
  const link = page.locator('footer').getByRole('link', { name: 'Code of Conduct' });
  await expect(link).toHaveAttribute('href', '/code-of-conduct');
  await link.click();
  await expect(page).toHaveURL(/\/code-of-conduct$/);
  await expect(page.getByRole('heading', { name: 'Code of Conduct', level: 1 })).toBeVisible();
});

test('code of conduct covers the mentor–mentee power gap and reporting', async ({ page }) => {
  await page.goto('/code-of-conduct');
  await expect(page.getByRole('heading', { name: 'What we expect' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What is not acceptable' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reporting a problem' })).toBeVisible();
  await expect(page.getByText(/more experienced and more powerful one/)).toBeVisible();
  // Contributor-facing full version lives in the repository.
  await expect(page.getByRole('link', { name: /Read the full Code of Conduct on GitHub/ }))
    .toHaveAttribute('href', /github\.com\/.+\/CODE_OF_CONDUCT\.md$/);
});

for (const [locale, heading] of [
  ['tr', 'Davranış Kuralları'],
  ['de', 'Verhaltenskodex'],
] as const) {
  test(`code of conduct is translated (${locale})`, async ({ page }) => {
    await page.goto('/code-of-conduct');
    await page.evaluate((l) => { document.cookie = `locale=${l};path=/`; }, locale);
    await page.reload();
    await expect(page.getByRole('heading', { name: heading, level: 1 }))
      .toBeVisible({ timeout: 10_000 });
  });
}
