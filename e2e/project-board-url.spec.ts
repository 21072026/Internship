import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a project can store a board URL and surface it on the public showcase', async ({ page }) => {
  const adminEmail = uniqueEmail('pb-admin');
  const admin = await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'PB Admin');
  let projectId = '';
  // Arbitrary fixture URL — the test only checks it round-trips through the API
  // and renders on the showcase; it does not require a real board to exist.
  const board = 'https://github.com/orgs/21072026/projects/1';

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/projects', {
      data: { name: 'Board Project', ownerType: 'ADMIN', ownerUserId: admin.id, boardUrl: board, isPublic: true },
    });
    expect(res.status()).toBe(201);
    projectId = (await res.json()).project.id;

    // Round-trips through the API.
    const list = await (await page.request.get('/api/projects')).json();
    expect(list.projects.find((p: { id: string }) => p.id === projectId)?.boardUrl).toBe(board);

    // Public showcase detail links to the board.
    await page.goto(`/projects/${projectId}`);
    const link = page.getByRole('link', { name: /Board|Pano/i });
    await expect(link).toHaveAttribute('href', board, { timeout: 10_000 });
  } finally {
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
    await cleanupByEmail(adminEmail);
  }
});
