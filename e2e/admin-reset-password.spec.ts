import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can trigger a password reset for a user; the link never reaches the browser', async ({ page }) => {
  const adminEmail = uniqueEmail('rstadmin');
  const menteeEmail = uniqueEmail('rstmentee');
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Reset Admin');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Reset Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto(`/admin/candidates/${mentee.id}`);
    const done = page.waitForResponse(
      (r) => r.url().includes(`/api/admin/users/${mentee.id}/reset-password`) && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /Reset password/ }).click();
    const res = await done;

    // A token was persisted, but the response carries no trace of it (#875) —
    // it used to come back as `resetUrl`, which put a live credential into
    // proxy logs, devtools and any screen-share.
    const body = await res.text();
    expect(body).not.toContain('/auth/reset?token=');
    expect(body).not.toContain('resetUrl');

    const token = await prisma.passwordResetToken.findFirst({
      where: { userId: mentee.id, used: false },
    });
    expect(token).not.toBeNull();
    expect(await page.content()).not.toContain(token!.token);

    // The action is audited and the account owner is told.
    await expect
      .poll(async () =>
        prisma.activityLog.count({ where: { action: 'admin.reset_password', targetId: mentee.id } })
      )
      .toBe(1);
    expect(await prisma.notification.count({ where: { userId: mentee.id, type: 'security' } })).toBe(1);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
