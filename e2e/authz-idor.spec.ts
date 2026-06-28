import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentee cannot access another user\'s CV or admin APIs (IDOR/RBAC)', async ({ page }) => {
  const aEmail = uniqueEmail('idor-a');
  const bEmail = uniqueEmail('idor-b');
  await seedUser(aEmail, 'IdorPass123', 'MENTEE', 'Mentee A');
  const b = await seedUser(bEmail, 'x', 'MENTEE', 'Mentee B');
  // Give B a CV that A should not be able to read.
  await prisma.cvFile.create({
    data: { userId: b.id, filename: 'b.pdf', contentType: 'application/pdf', size: 3, data: Buffer.from('pdf') },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', aEmail);
    await page.fill('input[type="password"]', 'IdorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Cross-user CV access is forbidden.
    expect((await page.request.get(`/api/cv/${b.id}`)).status()).toBe(403);
    // Admin-only APIs are denied to a mentee.
    expect((await page.request.get('/api/users')).status()).toBe(401);
    expect((await page.request.get('/api/admin/analytics')).status()).toBe(401);
    // The mentee can read their own CV endpoint (404, not 403 — no CV, but allowed).
    expect((await page.request.get(`/api/cv/${(await prisma.user.findUnique({ where: { email: aEmail } }))!.id}`)).status()).toBe(404);
  } finally {
    await prisma.cvFile.deleteMany({ where: { userId: b.id } });
    await cleanupByEmail(aEmail);
    await cleanupByEmail(bEmail);
  }
});
