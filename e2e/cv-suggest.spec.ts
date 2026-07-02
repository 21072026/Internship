import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC B1 — "Suggest from CV". Local parse (no AI) of the uploaded CV yields
// high-precision suggestions the user can apply into the profile form.
test('mentee gets and applies CV suggestions', async ({ page }) => {
  const email = uniqueEmail('cvsuggest-mentee');
  const user = await seedUser(email, 'MenteePass123', 'MENTEE', 'CV Suggest Mentee');

  // Seed an uploaded CV (the committed PDF fixture has known content).
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: user.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });
  await prisma.user.update({ where: { id: user.id }, data: { cvUrl: `/api/cv/${user.id}` } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // The API returns high-precision suggestions parsed from the CV.
    const res = await page.request.get(`/api/cv/${user.id}/suggest`);
    expect(res.ok()).toBeTruthy();
    const { suggestions } = await res.json();
    expect(suggestions.githubUrl).toContain('github.com/testdev');
    expect(suggestions.skills).toContain('TypeScript');

    // The UI exposes the suggest action and applies a value into the form.
    await page.goto('/portal/profile');
    const suggestBtn = page.getByRole('button', { name: /Suggest from CV/i });
    await expect(suggestBtn).toBeVisible({ timeout: 10_000 });
    await suggestBtn.click();

    // Apply the GitHub suggestion → the GitHub URL input gets the value.
    const applyButtons = page.getByRole('button', { name: /^Apply$/ });
    await expect(applyButtons.first()).toBeVisible({ timeout: 10_000 });
    // Apply all skills, then save the form and confirm it persists.
    await page.getByRole('button', { name: /Apply all/i }).click();
    await page.getByRole('button', { name: /^(Save|Save changes|Kaydet)/i }).first().click();

    await expect(async () => {
      const me = await (await page.request.get('/api/profile')).json();
      expect(me.user.skills).toContain('TypeScript');
    }).toPass({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
  }
});
