import { test, expect } from '@playwright/test';
import { buildSignupWindow, LOW_VERIFICATION_RATE, MIN_SIGNUPS_TO_JUDGE } from '@/lib/signupFunnel';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// #1191: the signup funnel makes a silent failure visible — sign-ups keep
// coming while verification mail is dead. The threshold rules are unit-tested
// (a real zero/low-volume state can't be staged on the shared database), and
// the admin analytics payload is asserted to carry both windows.

test.describe('buildSignupWindow', () => {
  test('zero sign-ups: rates are null and it never warns (no division by zero)', () => {
    const w = buildSignupWindow(7, { registered: 0, verified: 0, active: 0 });
    expect(w.verifiedRate).toBeNull();
    expect(w.activeRate).toBeNull();
    expect(w.warn).toBe(false);
  });

  test('low verification warns only with enough volume to judge', () => {
    // Below the volume floor a bad ratio is noise, not a signal.
    const quiet = buildSignupWindow(7, { registered: MIN_SIGNUPS_TO_JUDGE - 1, verified: 0, active: 0 });
    expect(quiet.verifiedRate).toBe(0);
    expect(quiet.warn).toBe(false);

    // Enough sign-ups and almost nobody verifies → warn.
    const broken = buildSignupWindow(7, { registered: 10, verified: 2, active: 1 });
    expect(broken.verifiedRate).toBe(20);
    expect(broken.activeRate).toBe(10);
    expect(broken.warn).toBe(true);

    // Healthy funnel at the same volume → no warning.
    const healthy = buildSignupWindow(7, { registered: 10, verified: 9, active: 8 });
    expect(healthy.verifiedRate).toBe(90);
    expect(healthy.warn).toBe(false);
  });

  test('the warning boundary is exactly the documented rate', () => {
    const atThreshold = buildSignupWindow(30, { registered: 100, verified: LOW_VERIFICATION_RATE, active: 10 });
    expect(atThreshold.verifiedRate).toBe(LOW_VERIFICATION_RATE);
    // At the threshold it is not yet "below par".
    expect(atThreshold.warn).toBe(false);
    expect(buildSignupWindow(30, { registered: 100, verified: LOW_VERIFICATION_RATE - 1, active: 10 }).warn).toBe(true);
  });
});

test('admin analytics carries the 7- and 30-day signup funnel', async ({ page }) => {
  const adminEmail = uniqueEmail('funnel-admin');
  await seedUser(adminEmail, 'FunnelAdmin123!', 'ADMIN', 'Funnel Admin');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'FunnelAdmin123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.get('/api/admin/analytics');
    expect(res.status()).toBe(200);
    const { signupFunnel } = await res.json();
    expect(signupFunnel).toHaveLength(2);
    expect(signupFunnel.map((w: { days: number }) => w.days)).toEqual([7, 30]);
    for (const w of signupFunnel as { registered: number; verified: number; active: number; warn: boolean }[]) {
      // The admin we just seeded is inside the 7-day window, so counts are real.
      expect(w.registered).toBeGreaterThanOrEqual(1);
      // Each step of the funnel is a subset of the one before it.
      expect(w.verified).toBeLessThanOrEqual(w.registered);
      expect(w.active).toBeLessThanOrEqual(w.verified);
      expect(typeof w.warn).toBe('boolean');
    }

    // The card renders on the analytics page.
    await page.goto('/admin/analytics');
    await expect(page.getByTestId('signup-funnel-card')).toBeVisible();
    await expect(page.getByTestId('signup-funnel-7')).toBeVisible();
    await expect(page.getByTestId('signup-funnel-rates-30')).toBeVisible();
  } finally {
    await cleanupByEmail(adminEmail);
    await prisma.$disconnect();
  }
});
