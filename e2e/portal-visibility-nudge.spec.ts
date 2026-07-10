import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #527 follow-up: the portal dashboard nudges mentees who have never decided on
// company visibility. Deciding (grant OR decline) removes the nudge for good.
test('undecided mentee sees the visibility nudge; deciding hides it', async ({ page }) => {
  const menteeEmail = uniqueEmail('nudge-mentee');
  const pw = 'NudgePass123';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Nudge Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Undecided → nudge shows, linking to account settings.
    const nudge = page.getByTestId('visibility-nudge');
    await expect(nudge).toBeVisible({ timeout: 10_000 });
    await expect(nudge.getByRole('link')).toHaveAttribute('href', '/account');

    // The mentee declines (a consent row with revokedAt = a decision).
    await page.request.post('/api/consent', { data: { type: 'TALENT_POOL_VISIBILITY', granted: false } });

    await page.goto('/portal');
    await expect(page.getByTestId('visibility-nudge')).toHaveCount(0);
  } finally {
    await cleanupByEmail(menteeEmail);
  }
});
