import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a fresh mentor is redirected to the onboarding wizard exactly once', async ({ page }) => {
  const email = uniqueEmail('mentorwizard');
  const mentor = await seedUser(email, 'WizardPass123!', 'MENTOR', 'Wizard Mentor');
  // seedUser marks mentors as already onboarded by default (so the other
  // ~30 specs seeding a mentor aren't sent to the wizard); this test is
  // specifically about a genuinely fresh one, so undo that.
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorOnboardingSeenAt: null } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'WizardPass123!');
    await page.click('button[type="submit"]');

    // First dashboard visit redirects to the wizard.
    await page.waitForURL((u) => u.pathname === '/onboarding', { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: /mentor profile/i })).toBeVisible({ timeout: 10_000 });

    // Step 1: Profile — full name is prefilled, bio can be filled in.
    await expect(page.getByLabel(/Full Name/i)).toHaveValue('Wizard Mentor');
    await page.getByLabel(/Bio/i).fill('I mentor frontend engineers.');
    await page.getByRole('button', { name: /Continue/i }).click();

    // Step 2: Expertise.
    await expect(page.getByLabel(/Skills/i)).toBeVisible();
    await page.getByLabel(/Skills/i).fill('React, TypeScript');
    await page.getByLabel(/Interests/i).fill('Frontend, mentoring');
    await page.getByRole('button', { name: /Continue/i }).click();

    // Step 3: Capacity.
    await expect(page.getByLabel(/capacity/i)).toBeVisible();
    await page.getByLabel(/capacity/i).fill('3');
    await page.getByRole('button', { name: /Continue/i }).click();

    // Step 4: Availability — finish without adding a slot.
    await expect(page.getByTestId('mentor-onboarding-finish')).toBeVisible();
    await page.getByTestId('mentor-onboarding-finish').click();

    // Finishing returns to the dashboard.
    await page.waitForURL((u) => u.pathname === '/mentor', { timeout: 20_000 });

    // Saved: bio, skills, interests and capacity persisted.
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.bio).toBe('I mentor frontend engineers.');
    expect(user?.skills).toEqual(['React', 'TypeScript']);
    expect(user?.interests).toBe('Frontend, mentoring');
    expect(user?.mentorCapacity).toBe(3);
    expect(user?.mentorOnboardingSeenAt).not.toBeNull();

    // A second visit to the dashboard does not redirect back to the wizard.
    await page.goto('/mentor');
    await expect(page).toHaveURL(/\/mentor$/);
  } finally {
    await cleanupByEmail(email);
  }
});

test('skipping the wizard returns to the dashboard and never redirects again', async ({ page }) => {
  const email = uniqueEmail('mentorskip');
  const mentor = await seedUser(email, 'SkipPass123!', 'MENTOR', 'Skip Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorOnboardingSeenAt: null } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'SkipPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname === '/onboarding', { timeout: 20_000 });

    await page.getByTestId('mentor-onboarding-skip').click();
    await page.waitForURL((u) => u.pathname === '/mentor', { timeout: 20_000 });

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.mentorOnboardingSeenAt).not.toBeNull();
    expect(user?.bio).toBeNull();

    // Revisiting the dashboard never sends them back to the wizard.
    await page.goto('/mentor');
    await expect(page).toHaveURL(/\/mentor$/);
  } finally {
    await cleanupByEmail(email);
  }
});

test('the existing mentee onboarding flow is unchanged', { tag: '@smoke' }, async ({ page }) => {
  const email = uniqueEmail('menteeunchanged');
  await seedUser(email, 'MenteePass123!', 'MENTEE', 'Unchanged Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123!');
    await page.click('button[type="submit"]');
    // Mentees still land on the portal, not an automatic onboarding redirect.
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { name: 'Complete Your Profile' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel(/Full Name/i)).toHaveValue('Unchanged Mentee');
  } finally {
    await cleanupByEmail(email);
  }
});
