import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

const switcher = 'mode-switcher';

test('an admin can switch between the admin and mentor views', { tag: '@smoke' }, async ({ page }) => {
  const adminEmail = uniqueEmail('mode-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Mode Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const box = page.getByTestId(switcher);
    await expect(box).toBeVisible();

    // Admin mode: the admin half is the inert state marker, the mentor half a link.
    await expect(box.getByText('Admin', { exact: true })).toHaveAttribute('aria-current', 'page');
    await box.getByRole('link', { name: 'Mentor', exact: true }).click();

    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });
    // The whole shell is now the mentor one, and it says so.
    await expect(page.getByRole('link', { name: 'My Mentees', exact: true })).toBeVisible();
    await expect(box.getByText('Mentor', { exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(box.getByText(/only the mentees you mentor yourself/i)).toBeVisible();

    // Switching back returns to the admin shell.
    await box.getByRole('link', { name: 'Admin', exact: true }).click();
    await page.waitForURL((u) => u.pathname === '/admin', { timeout: 20_000 });
    await expect(page.getByRole('link', { name: 'Companies', exact: true })).toBeVisible();
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('the mode switch keeps the current section when both views have one', async ({ page }) => {
  const adminEmail = uniqueEmail('mode-section-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Section Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // A shared section maps 1:1 …
    await page.goto('/admin/board');
    await page.getByTestId(switcher).getByRole('link', { name: 'Mentor', exact: true }).click();
    await page.waitForURL((u) => u.pathname === '/mentor/board', { timeout: 20_000 });

    // … an aliased one maps to its equivalent …
    await page.goto('/admin/candidates');
    await page.getByTestId(switcher).getByRole('link', { name: 'Mentor', exact: true }).click();
    await page.waitForURL((u) => u.pathname === '/mentor/mentees', { timeout: 20_000 });

    // … and an admin-only section falls back to the mentor dashboard.
    await page.goto('/admin/settings');
    await page.getByTestId(switcher).getByRole('link', { name: 'Mentor', exact: true }).click();
    await page.waitForURL((u) => u.pathname === '/mentor', { timeout: 20_000 });
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('a plain mentor never sees the mode switch', async ({ page }) => {
  const mentorEmail = uniqueEmail('mode-mentor');
  await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Mode Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await expect(page.getByTestId(switcher)).toHaveCount(0);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
