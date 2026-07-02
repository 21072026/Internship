import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { makeConsentRenewToken } from '../src/lib/consentRenew';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

function monthsAgo(n: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

// Slice A (#403): retention re-consent. A signed renewal link refreshes consent
// and clears the reminder stamp; overdue candidates surface in the admin review.
test('a valid renewal token refreshes consent and clears the reminder stamp', async ({ page }) => {
  const email = uniqueEmail('retention');
  const u = await seedUser(email, 'Pass1234!', 'MENTEE', 'Retention Renew');
  await prisma.user.update({
    where: { id: u.id },
    data: { consentAt: monthsAgo(18), retentionReminderSentAt: new Date() },
  });
  try {
    const res = await page.request.post('/api/consent/renew', {
      data: { token: makeConsentRenewToken(u.id) },
    });
    expect(res.ok()).toBeTruthy();

    const after = await prisma.user.findUnique({ where: { id: u.id } });
    expect(after?.retentionReminderSentAt).toBeNull();
    // consentAt refreshed to (about) now.
    expect(after?.consentAt && Date.now() - after.consentAt.getTime() < 5 * 60 * 1000).toBeTruthy();

    const consent = await prisma.userConsent.findUnique({
      where: { userId_type: { userId: u.id, type: 'PRIVACY_POLICY' } },
    });
    expect(consent?.grantedAt).not.toBeNull();
  } finally {
    await cleanupByEmail(email);
  }
});

test('an invalid renewal token is rejected', async ({ page }) => {
  const res = await page.request.post('/api/consent/renew', { data: { token: 'bogus.deadbeef' } });
  expect(res.status()).toBe(400);
});

test('admin retention review lists a candidate past the retention limit', async ({ page }) => {
  const email = uniqueEmail('retention-admin');
  const name = `Retention Overdue ${Date.now().toString(36)}`;
  const u = await seedUser(email, 'Pass1234!', 'MENTEE', name);
  await prisma.user.update({ where: { id: u.id }, data: { consentAt: monthsAgo(18) } });
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto('/admin/retention');
    await expect(page.getByText(name)).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});
