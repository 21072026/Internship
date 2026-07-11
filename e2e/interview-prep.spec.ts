import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Faz 2 (#536): interview prep — hidden without a provider (availability
// endpoint), free for the mentee, gated by the shared AI gate. CI has no key,
// so POSTs stop at 501 and consume no credit.
test('interview prep reports unavailability without a provider and consumes no credit', async ({ page }) => {
  const email = uniqueEmail('prep-mentee');
  const pw = 'PrepPass123';
  const user = await seedUser(email, pw, 'MENTEE', 'Prep Mentee');
  await prisma.user.update({ where: { id: user.id }, data: { targetPosition: 'Backend Developer', skills: ['Java'] } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Availability: no key in CI → configured:false → the portal card hides.
    const avail = await (await page.request.get('/api/interview-prep')).json();
    expect(avail.configured).toBe(false);
    await page.goto('/portal');
    await expect(page.getByTestId('interview-prep')).toHaveCount(0);

    // Direct POST passes the quota gate and stops at the provider, consuming
    // no credit.
    const usageBefore = await prisma.aiUsage.count();
    const res = await page.request.post('/api/interview-prep', { data: {} });
    expect(res.status()).toBe(501);
    expect((await res.json()).code).toBe('not_configured');
    expect(await prisma.aiUsage.count()).toBe(usageBefore);

    // Missing position (profile cleared) → clear 400, not a provider error.
    await prisma.user.update({ where: { id: user.id }, data: { targetPosition: null } });
    const noPos = await page.request.post('/api/interview-prep', { data: {} });
    expect(noPos.status()).toBe(400);
    expect((await noPos.json()).code).toBe('no_position');
  } finally {
    await cleanupByEmail(email);
  }
});
