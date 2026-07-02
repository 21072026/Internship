import { test, expect } from '@playwright/test';
import { prisma, seedInvite, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #433: an invitation should progress sent → link opened → registered → verified,
// each stamped with a timestamp and visible to admins.
test('invitation lifecycle is stamped and shown in Recent Invitations', async ({ page }) => {
  const email = uniqueEmail('inv-life');
  const token = await seedInvite(email, 'MENTEE');

  try {
    // 1. Sent only → opened/registered/verified are empty.
    let inv = await prisma.invitationToken.findUnique({ where: { token } });
    expect(inv?.openedAt).toBeNull();
    expect(inv?.registeredAt).toBeNull();
    expect(inv?.verifiedAt).toBeNull();

    // 2. Opening the register link stamps openedAt.
    const opened = await page.request.post('/api/invite/opened', { data: { token } });
    expect(opened.ok()).toBeTruthy();
    inv = await prisma.invitationToken.findUnique({ where: { token } });
    expect(inv?.openedAt).not.toBeNull();

    // 3. Registering stamps registeredAt and (invited → auto-verified) verifiedAt.
    const reg = await page.request.post('/api/register', {
      data: { token, email, password: 'Passw0rd!23', fullName: 'Invite Lifecycle', consent: true },
    });
    expect(reg.ok()).toBeTruthy();
    inv = await prisma.invitationToken.findUnique({ where: { token } });
    expect(inv?.used).toBe(true);
    expect(inv?.registeredAt).not.toBeNull();
    expect(inv?.verifiedAt).not.toBeNull();

    // 4. Admin sees the invite with its lifecycle timeline.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto('/admin/invite');
    const row = page.getByTestId(`invite-${inv!.id}`);
    await expect(row).toBeVisible();
    await expect(row.getByText(/registered/i)).toBeVisible();
    await expect(row.getByText(/verified/i)).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});
