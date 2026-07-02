import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// The require2fa Setting is global and the CI DB is shared across tests, so this
// spec MUST restore it to 'off' no matter what — otherwise every later admin
// login would be redirected to the setup gate and cascade-fail.
async function setPolicy(value: string) {
  await prisma.setting.upsert({
    where: { key: 'require2fa' },
    create: { key: 'require2fa', value },
    update: { value },
  });
}

test.afterAll(async () => {
  await setPolicy('off');
  await prisma.$disconnect();
});

test('when 2FA is required for admins, an admin without 2FA is held at the setup gate', async ({ page }) => {
  const adminEmail = uniqueEmail('enf-admin');
  const password = 'AdminPass123!';
  await seedUser(adminEmail, password, 'ADMIN', 'Enforce Admin');

  try {
    await setPolicy('off');
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Turn the policy on via the admin settings API (also covers the schema).
    const put = await page.request.put('/api/admin/settings', { data: { require2fa: 'admins' } });
    expect(put.ok()).toBeTruthy();

    // Navigating into the admin area now redirects to the 2FA setup gate.
    await page.goto('/admin');
    await page.waitForURL((u) => u.pathname.startsWith('/security-setup'), { timeout: 20_000 });
    await expect(page.getByText(/two-factor authentication/i)).toBeVisible({ timeout: 10_000 });

    // Relaxing the policy lets the admin back in without setting up 2FA.
    await setPolicy('off');
    await page.goto('/admin');
    await expect(page).toHaveURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
  } finally {
    await setPolicy('off');
    await cleanupByEmail(adminEmail);
  }
});
