import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #937 — mentor-only MENTOR_DIRECTORY_VISIBILITY consent (story #900).
// Directory listing requires an active grant (grantedAt set, revokedAt null).

const TOGGLE_TITLE = 'Listing in the mentor directory';

async function signIn(page: Page, email: string, password: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

test('mentor can grant and revoke directory visibility from /account', async ({ page }) => {
  const email = uniqueEmail('dir-consent-mentor');
  const user = await seedUser(email, 'MentorPass123', 'MENTOR', 'Directory Consent Mentor');

  try {
    await signIn(page, email, 'MentorPass123', '/mentor');

    await page.goto('/account');
    const toggle = page
      .locator('label', { hasText: TOGGLE_TITLE })
      .locator('input[type="checkbox"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked(); // off by default

    // Grant: the row records when consent was given and clears any revocation.
    await toggle.check();
    await expect
      .poll(async () => {
        const c = await prisma.userConsent.findUnique({
          where: { userId_type: { userId: user.id, type: 'MENTOR_DIRECTORY_VISIBILITY' } },
        });
        return c ? { granted: !!c.grantedAt, revoked: !!c.revokedAt } : null;
      })
      .toEqual({ granted: true, revoked: false });

    // Revoke: grantedAt stays (audit trail) but revokedAt is set.
    await toggle.uncheck();
    await expect
      .poll(async () => {
        const c = await prisma.userConsent.findUnique({
          where: { userId_type: { userId: user.id, type: 'MENTOR_DIRECTORY_VISIBILITY' } },
        });
        return c ? !!c.revokedAt : null;
      })
      .toBe(true);
  } finally {
    await cleanupByEmail(email);
  }
});

test('mentee does not see the mentor-directory toggle', async ({ page }) => {
  const email = uniqueEmail('dir-consent-mentee');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'Directory Consent Mentee');

  try {
    await signIn(page, email, 'MenteePass123', '/portal');

    await page.goto('/account');
    // Wait until the consent section has rendered (an all-roles toggle is visible)
    // before asserting the mentor-only one is absent.
    await expect(page.locator('label', { hasText: 'AI-assisted CV reading' })).toBeVisible();
    await expect(page.locator('label', { hasText: TOGGLE_TITLE })).toHaveCount(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('POST /api/consent accepts the new type for a mentor and logs consent.grant', async ({ page }) => {
  const email = uniqueEmail('dir-consent-api');
  const user = await seedUser(email, 'MentorPass123', 'MENTOR', 'Directory Consent Api');

  try {
    await signIn(page, email, 'MentorPass123', '/mentor');

    const res = await page.request.post('/api/consent', {
      data: { type: 'MENTOR_DIRECTORY_VISIBILITY', granted: true },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.consents.MENTOR_DIRECTORY_VISIBILITY).toBe(true);

    // logActivity runs before the response is sent, so the row exists already.
    const log = await prisma.activityLog.findFirst({
      where: {
        action: 'consent.grant',
        actorId: user.id,
        targetType: 'consent',
        targetId: 'MENTOR_DIRECTORY_VISIBILITY',
      },
    });
    expect(log).not.toBeNull();
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorEmail: email } }).catch(() => {});
    await cleanupByEmail(email);
  }
});
