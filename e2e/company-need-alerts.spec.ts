import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import bcrypt from 'bcryptjs';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Premium Faz 1 (#530): the daily cron alerts a premium company (holding the
// COMPANY_NEED_MATCH_ALERTS entitlement) when a consenting candidate matches
// one of its open positions — once per candidate (deduped), and never for a
// company without the entitlement. Driven through the admin /api/cron endpoint.
test('need-match alerts fire once for premium companies only, on consenting candidates', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const adminEmail = uniqueEmail('need-admin');
  const premiumUserEmail = uniqueEmail('need-premium-user');
  const freeUserEmail = uniqueEmail('need-free-user');
  const menteeEmail = uniqueEmail('need-mentee');
  const pw = 'NeedAlertPass123';
  const position = `Backend Developer ${stamp}`;

  await seedUser(adminEmail, pw, 'ADMIN', 'Need Admin');
  const hash = await bcrypt.hash(pw, 10);

  const premiumCo = await prisma.company.create({
    data: {
      name: `Premium Need Co ${stamp}`,
      entitlements: { create: { feature: 'COMPANY_NEED_MATCH_ALERTS' } },
      needs: { create: { position, count: 1, period: '2026' } },
    },
  });
  const freeCo = await prisma.company.create({
    data: {
      name: `Free Need Co ${stamp}`,
      needs: { create: { position, count: 1, period: '2026' } },
    },
  });
  const premiumUser = await prisma.user.create({
    data: { email: premiumUserEmail, password: hash, role: 'COMPANY', fullName: 'Premium Co User', skills: [], companyId: premiumCo.id },
  });
  await prisma.user.create({
    data: { email: freeUserEmail, password: hash, role: 'COMPANY', fullName: 'Free Co User', skills: [], companyId: freeCo.id },
  });

  // A consenting (publicProfile) mentee whose target position matches the need.
  const mentee = await prisma.user.create({
    data: { email: menteeEmail, password: hash, role: 'MENTEE', fullName: 'Matching Mentee', skills: [], targetPosition: position, publicProfile: true },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const run1 = await page.request.get('/api/cron');
    expect(run1.ok()).toBeTruthy();

    // Premium company: alert row + in-app notification created exactly once.
    await expect
      .poll(async () => prisma.companyNeedAlert.count({ where: { companyId: premiumCo.id, menteeId: mentee.id } }), { timeout: 10_000 })
      .toBe(1);
    expect(await prisma.notification.count({ where: { userId: premiumUser.id, type: 'need_match' } })).toBe(1);

    // Free company: no entitlement → no alert.
    expect(await prisma.companyNeedAlert.count({ where: { companyId: freeCo.id } })).toBe(0);

    // Running again does not re-alert (deduped).
    const run2 = await page.request.get('/api/cron');
    expect(run2.ok()).toBeTruthy();
    expect(await prisma.companyNeedAlert.count({ where: { companyId: premiumCo.id, menteeId: mentee.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: premiumUser.id, type: 'need_match' } })).toBe(1);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: premiumUser.id } });
    await prisma.companyNeedAlert.deleteMany({ where: { menteeId: mentee.id } });
    await prisma.companyNeed.deleteMany({ where: { companyId: { in: [premiumCo.id, freeCo.id] } } });
    await prisma.companyEntitlement.deleteMany({ where: { companyId: premiumCo.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(premiumUserEmail);
    await cleanupByEmail(freeUserEmail);
    await cleanupByEmail(adminEmail);
    await prisma.company.delete({ where: { id: premiumCo.id } }).catch(() => {});
    await prisma.company.delete({ where: { id: freeCo.id } }).catch(() => {});
  }
});
