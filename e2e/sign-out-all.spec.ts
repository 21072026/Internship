import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function login(page: Page, email: string, pw: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });
}

// The signed-in email per /api/auth/session (null when unauthenticated).
async function sessionEmail(page: Page): Promise<string | null> {
  const s = await (await page.request.get('/api/auth/session')).json();
  return s?.user?.email ?? null;
}

// EPIC J (#423) — "sign out of all devices" invalidates every existing session
// (on all devices) while leaving new logins working.
test('sign out of all devices revokes other sessions and still allows fresh login', async ({ browser }) => {
  const email = uniqueEmail('soa');
  const pw = 'SoaPass123!';
  await seedUser(email, pw, 'MENTEE', 'SignOutAll User');

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    // Two independent sessions for the same user (two "devices").
    await login(a, email, pw);
    await login(b, email, pw);
    expect(await sessionEmail(a)).toBe(email);
    expect(await sessionEmail(b)).toBe(email);

    // Device A triggers a global sign-out.
    const res = await a.request.post('/api/account/sign-out-all');
    expect(res.ok()).toBeTruthy();

    // Device B's session is now invalid on its next request.
    await expect.poll(async () => sessionEmail(b), { timeout: 10_000 }).toBeNull();

    // A brand-new login still works (the cutoff only rejects OLD tokens).
    const ctxC = await browser.newContext();
    try {
      const c = await ctxC.newPage();
      await login(c, email, pw);
      expect(await sessionEmail(c)).toBe(email);
    } finally {
      await ctxC.close();
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
    await cleanupByEmail(email);
  }
});
