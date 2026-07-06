import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, pw: string, home: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

test('page-view tracking is strictly opt-in (no consent → nothing stored)', async ({ page }) => {
  const email = uniqueEmail('track');
  const pw = 'TrackPass123';
  const user = await seedUser(email, pw, 'MENTEE', 'Track Mentee');

  try {
    await signIn(page, email, pw, '/portal');

    // Without consent, the endpoint accepts the beacon but stores nothing.
    const r1 = await page.request.post('/api/track/pageview', {
      data: { path: '/portal?secret=should-be-stripped', durationSec: 12 },
    });
    expect(r1.status()).toBe(204);
    expect(await prisma.pageView.count({ where: { userId: user.id } })).toBe(0);

    // Grant activity-tracking consent.
    const grant = await page.request.post('/api/consent', {
      data: { type: 'ACTIVITY_TRACKING', granted: true },
    });
    expect(grant.ok()).toBeTruthy();

    // Now the same beacon is recorded, with the query string stripped.
    const r2 = await page.request.post('/api/track/pageview', {
      data: { path: '/portal?secret=should-be-stripped', durationSec: 12 },
    });
    expect(r2.status()).toBe(204);

    await expect
      .poll(async () => prisma.pageView.count({ where: { userId: user.id } }), { timeout: 10_000 })
      .toBe(1);
    const view = await prisma.pageView.findFirst({ where: { userId: user.id } });
    expect(view?.path).toBe('/portal'); // query stripped
    expect(view?.durationSec).toBe(12);
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(fresh?.lastSeenAt).not.toBeNull();
  } finally {
    await cleanupByEmail(email);
  }
});
