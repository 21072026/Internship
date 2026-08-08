import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('public project showcase shows public projects only', async ({ page }) => {
  const ownerEmail = uniqueEmail('show-mentor');
  const owner = await seedUser(ownerEmail, 'x', 'MENTOR', 'Showcase Mentor');
  const pub = await prisma.project.create({
    data: { name: 'Aurora Showcase', isPublic: true, ownerType: 'MENTOR', ownerUserId: owner.id, technologies: ['React'] },
  });
  const priv = await prisma.project.create({
    data: { name: 'Hidden Secret', isPublic: false, ownerType: 'MENTOR', ownerUserId: owner.id },
  });

  try {
    // Anonymous visitor sees the public one, not the private one.
    await page.goto('/projects');
    await expect(page.getByText('Aurora Showcase')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Hidden Secret')).toHaveCount(0);

    // Public detail renders.
    await page.goto(`/projects/${pub.id}`);
    await expect(page.getByRole('heading', { name: 'Aurora Showcase' })).toBeVisible();

    // Private detail is not exposed (404).
    const res = await page.goto(`/projects/${priv.id}`);
    expect(res?.status()).toBe(404);
  } finally {
    await prisma.project.deleteMany({ where: { ownerUserId: owner.id } });
    await cleanupByEmail(ownerEmail);
  }
});

// #1159: /projects lives outside the role shell — no sidebar, and the header
// wordmark was the only link on the page. A signed-in visitor who followed
// "Browse the project showcase" from /portal/projects had no way back into the
// app short of the browser's back button (and on mobile, no chrome at all).
test('project showcase has a back link, targeted at who is looking', async ({ page }) => {
  const menteeEmail = uniqueEmail('show-back-mentee');
  const pw = 'ShowBack123';
  await seedUser(menteeEmail, pw, 'MENTEE', 'Showcase Back Mentee');

  try {
    // Anonymous visitor: back to the landing page.
    await page.goto('/projects');
    const anonBack = page.getByTestId('showcase-back');
    await expect(anonBack).toBeVisible({ timeout: 10_000 });
    await expect(anonBack).toHaveText('Back to home');
    await anonBack.click();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 20_000 });

    // Signed-in mentee: back to their own dashboard, not the landing page.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/projects');
    const back = page.getByTestId('showcase-back');
    await expect(back).toHaveText('Back to dashboard', { timeout: 10_000 });
    await back.click();
    await page.waitForURL((u) => u.pathname === '/portal', { timeout: 20_000 });
  } finally {
    await cleanupByEmail(menteeEmail);
  }
});
