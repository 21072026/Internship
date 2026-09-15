import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { freshIp } from './helpers/rateLimit';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a user can export their own data', async ({ page }) => {
  const email = uniqueEmail('exp');
  await seedUser(email, 'ExportPass123', 'MENTEE', 'Export Me');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'ExportPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const res = await page.request.get('/api/account/export');
    expect(res.ok()).toBeTruthy();
    expect(res.headers()['content-type']).toContain('application/json');
    const data = await res.json();
    expect(data.user.email).toBe(email);
    expect(data.exportedAt).toBeTruthy();
  } finally {
    await cleanupByEmail(email);
  }
});

test('registration records consent and the privacy page is public', async ({ page }) => {
  const email = uniqueEmail('consent');
  try {
    const res = await page.request.post('/api/register', {
      headers: freshIp('register privacy'),
      data: { email, password: 'ConsentPass123', fullName: 'Consent User' },
    });
    expect(res.ok()).toBeTruthy();
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.consentAt).not.toBeNull();

    await page.goto('/privacy');
    await expect(page.getByRole('heading', { name: /Privacy/i })).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
  }
});
