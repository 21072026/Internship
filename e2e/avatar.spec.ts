import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
);

test('a user can upload and remove a profile picture', async ({ page }) => {
  const email = uniqueEmail('avamentee');
  const user = await seedUser(email, 'AvatarPass123', 'MENTEE', 'Ava Tar');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'AvatarPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/account');
    const uploaded = page.waitForResponse((r) => r.url().endsWith('/api/avatar') && r.request().method() === 'POST');
    await page.locator('input[type="file"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await uploaded;

    await expect.poll(async () => prisma.avatarFile.findUnique({ where: { userId: user.id } })).not.toBeNull();
    const u1 = await prisma.user.findUnique({ where: { id: user.id } });
    expect(u1!.avatarUrl).toContain(`/api/avatar/${user.id}`);

    // Remove it.
    const removed = page.waitForResponse((r) => r.url().includes(`/api/avatar/${user.id}`) && r.request().method() === 'DELETE');
    await page.getByRole('button', { name: 'Remove' }).click();
    await removed;
    await expect.poll(async () => prisma.avatarFile.findUnique({ where: { userId: user.id } })).toBeNull();
  } finally {
    await cleanupByEmail(email);
  }
});
