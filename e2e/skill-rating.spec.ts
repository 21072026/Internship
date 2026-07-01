import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Skill self-assessment uses a 1–5 star picker; clicking a star persists that level.
test('mentee sets a skill level with the star rating and it persists', async ({ page }) => {
  const email = uniqueEmail('skillrate-mentee');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'Skill Rate Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/portal/profile');
    // Enter a skill so its rating row appears.
    const skills = page.locator('input[name="skills"]');
    await skills.fill('React');
    // React's rating group; click the 4/5 star.
    const group = page.getByRole('radiogroup', { name: 'React' });
    await expect(group).toBeVisible({ timeout: 10_000 });
    await group.getByRole('radio', { name: '4/5' }).click();
    await expect(group.getByRole('radio', { name: '4/5' })).toHaveAttribute('aria-checked', 'true');

    // Save and confirm persistence.
    await page.getByRole('button', { name: /^(Save|Save changes|Kaydet)/i }).first().click();
    await expect(async () => {
      const me = await (await page.request.get('/api/profile')).json();
      expect(me.user.skillLevels?.React).toBe(4);
    }).toPass({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
  }
});
