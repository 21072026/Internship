import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('previously hardcoded admin strings are translated in Turkish', async ({ page }) => {
  const email = uniqueEmail('i18ncov-admin');
  await seedUser(email, 'AdminPass123', 'ADMIN', 'Cov Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Switch to Turkish.
    await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });

    await page.goto('/admin/mentorship');
    await expect(page.getByRole('button', { name: 'Mentorluk ata' })).toBeVisible({ timeout: 10_000 });
    // The "assign mentorship" modal's own form labels were previously hardcoded English.
    await page.getByRole('button', { name: 'Mentorluk ata' }).click();
    await expect(page.getByText('Şirket (opsiyonel)')).toBeVisible({ timeout: 10_000 });

    await page.goto('/admin/companies');
    await expect(page.getByRole('button', { name: 'Şirket ekle' })).toBeVisible({ timeout: 10_000 });
    // CompanyForm's field labels were previously hardcoded English.
    await page.getByRole('button', { name: 'Şirket ekle' }).click();
    await expect(page.getByText('Şirket Adı')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Staj İhtiyaçları')).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
  }
});

// #1377: the mentor dashboard's "Recent interactions" card had its footer link
// typed as a JSX literal ("View all interactions →") while every other string
// on the page came from `t.mentor.*`. `npm run check:i18n` only compares keys
// between the three dictionaries, so a literal in JSX is invisible to it —
// this spec is the part of the guard that actually reads the rendered page.
test('mentor dashboard has no untranslated strings in TR or DE', async ({ page }) => {
  const email = uniqueEmail('i18ncov-mentor');
  await seedUser(email, 'MentorPass123', 'MENTOR', 'Cov Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
    await page.goto('/mentor');
    await expect(
      page.getByRole('link', { name: /Tüm etkileşimleri gör/ }),
    ).toBeVisible({ timeout: 10_000 });
    // The English literal must be gone, not merely joined by a translation.
    await expect(page.getByText('View all interactions')).toHaveCount(0);
    // The app shell's mobile drawer controls were hardcoded too. They are
    // `lg:hidden`, i.e. display:none on the desktop viewport this project
    // runs, so match the attribute rather than the accessibility tree.
    await expect(page.locator('[aria-label="Menüyü aç"]')).toHaveCount(1);
    await expect(page.locator('[aria-label="Open menu"]')).toHaveCount(0);

    await page.evaluate(() => { document.cookie = 'locale=de;path=/'; });
    await page.goto('/mentor');
    await expect(
      page.getByRole('link', { name: /Alle Interaktionen ansehen/ }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('View all interactions')).toHaveCount(0);
    await expect(page.locator('[aria-label="Menü öffnen"]')).toHaveCount(1);
  } finally {
    await cleanupByEmail(email);
  }
});
