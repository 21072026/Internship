import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('selecting an email template fills the subject and body', async ({ page }) => {
  const email = uniqueEmail('et-mentor');
  await seedUser(email, 'MentorPass123', 'MENTOR', 'ET Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto('/mentor/email');
    await page.locator('#email-template').selectOption('welcome');

    // Subject input now carries the template subject.
    const subject = page.getByLabel('Subject');
    await expect(subject).toHaveValue(/Welcome to the program/i);
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue(/\{name\}/);
  } finally {
    await cleanupByEmail(email);
  }
});
