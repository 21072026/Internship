import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1194: /admin/users used to render one amber "Inactive" badge for five
// unrelated situations, so an account nobody could reach looked the same as one
// an admin had switched off on purpose. Each state now has its own label, and
// the one that is waiting on a click gets a resend button.
test('admin/users tells the inactive states apart and offers a resend', async ({ page }) => {
  const adminEmail = uniqueEmail('state-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'State Admin');

  // Never clicked the verification link: inactive + unverified.
  const unverified = await seedUser(uniqueEmail('state-unverified'), 'x', 'MENTEE', 'State Unverified');
  await prisma.user.update({
    where: { id: unverified.id },
    data: { isActive: false, emailVerified: false, pendingApproval: false },
  });

  // Verified, but an admin turned the account off.
  const deactivated = await seedUser(uniqueEmail('state-deactivated'), 'x', 'MENTEE', 'State Deactivated');
  await prisma.user.update({
    where: { id: deactivated.id },
    data: { isActive: false, emailVerified: true, pendingApproval: false },
  });

  // Verified and waiting on a human (selfRegistration: 'manual').
  const pending = await seedUser(uniqueEmail('state-pending'), 'x', 'MENTEE', 'State Pending');
  await prisma.user.update({
    where: { id: pending.id },
    data: { isActive: false, emailVerified: true, pendingApproval: true },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // All three are inactive, so they live on the Archived tab.
    await page.goto('/admin/users');
    await page.getByTestId('status-view-archived').click();

    const unverifiedRow = page.getByTestId(`user-row-${unverified.id}`);
    await expect(unverifiedRow).toBeVisible({ timeout: 10_000 });
    await expect(unverifiedRow.getByText('Email not verified', { exact: true })).toBeVisible();

    await expect(
      page.getByTestId(`user-row-${deactivated.id}`).getByText('Deactivated', { exact: true }),
    ).toBeVisible();

    await expect(
      page.getByTestId(`user-row-${pending.id}`).getByText('Awaiting approval', { exact: true }),
    ).toBeVisible();

    // The resend button belongs to the unverified row only — resending to an
    // account that is not waiting on a click would be noise.
    await expect(page.getByTestId(`resend-verification-${unverified.id}`)).toBeVisible();
    await expect(page.getByTestId(`resend-verification-${deactivated.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`resend-verification-${pending.id}`)).toHaveCount(0);

    // The endpoint mints a fresh token for the unverified account, and refuses
    // the ones that are not waiting on a verification click.
    const ok = await page.request.post(`/api/users/${unverified.id}/resend-verification`);
    expect(ok.ok()).toBeTruthy();
    expect(await prisma.emailVerificationToken.count({ where: { userId: unverified.id, used: false } })).toBe(1);

    const refused = await page.request.post(`/api/users/${deactivated.id}/resend-verification`);
    expect(refused.status()).toBe(409);
    expect((await refused.json()).accountState).toBe('deactivated');
  } finally {
    await cleanupByEmail(unverified.email);
    await cleanupByEmail(deactivated.email);
    await cleanupByEmail(pending.email);
    await cleanupByEmail(adminEmail);
  }
});
