import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('profile accepts an internal /api/cv path as the CV URL', async ({ page }) => {
  const email = uniqueEmail('cvurl-mentee');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'CV Url Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // A relative internal path (as set by CV upload) must be accepted.
    const put = await page.request.put('/api/profile', { data: { cvUrl: '/api/cv/abc123' } });
    expect(put.ok()).toBeTruthy();
    const me = await (await page.request.get('/api/profile')).json();
    expect(me.user.cvUrl).toBe('/api/cv/abc123');

    // A full URL still works.
    const put2 = await page.request.put('/api/profile', { data: { cvUrl: 'https://example.com/cv.pdf' } });
    expect(put2.ok()).toBeTruthy();
  } finally {
    await cleanupByEmail(email);
  }
});
