import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC B2 — reusable per-user consent. Off by default; grant/revoke persists.
test('user can grant and revoke a consent', async ({ page }) => {
  const email = uniqueEmail('consent-mentee');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'Consent Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Off by default.
    let got = await (await page.request.get('/api/consent')).json();
    expect(got.consents.AI_CV_PARSING ?? false).toBe(false);

    // Grant.
    const grant = await page.request.post('/api/consent', { data: { type: 'AI_CV_PARSING', granted: true } });
    expect(grant.ok()).toBeTruthy();
    got = await (await page.request.get('/api/consent')).json();
    expect(got.consents.AI_CV_PARSING).toBe(true);

    // Revoke.
    await page.request.post('/api/consent', { data: { type: 'AI_CV_PARSING', granted: false } });
    got = await (await page.request.get('/api/consent')).json();
    expect(got.consents.AI_CV_PARSING).toBe(false);
  } finally {
    await cleanupByEmail(email);
  }
});
