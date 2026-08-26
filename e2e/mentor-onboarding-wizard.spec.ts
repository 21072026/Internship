import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a fresh mentor is redirected to the onboarding wizard exactly once', async ({ page }) => {
  const email = uniqueEmail('mentorwizard');
  const mentor = await seedUser(email, 'WizardPass123!', 'MENTOR', 'Wizard Mentor');

  try {
    // Establish the session before making this mentor "fresh". Sign-in itself
    // can issue two dashboard navigations (the session effect and the explicit
    // post-submit redirect); putting the one-shot marker at null before that
    // lets the first request consume it while the second renders /mentor.
    await signInAndSettle(page, email, 'WizardPass123!', '/mentor');
    const fresh = await prisma.user.update({
      where: { id: mentor.id },
      data: { mentorOnboardingSeenAt: null },
      select: { id: true, role: true, mentorOnboardingSeenAt: true },
    });
    expect(fresh).toEqual({ id: mentor.id, role: 'MENTOR', mentorOnboardingSeenAt: null });

    // First dashboard visit redirects to the wizard.
    await page.goto('/mentor');
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

  try {
    await signInAndSettle(page, email, 'SkipPass123!', '/mentor');
    const fresh = await prisma.user.update({
      where: { id: mentor.id },
      data: { mentorOnboardingSeenAt: null },
      select: { id: true, role: true, mentorOnboardingSeenAt: true },
    });
    expect(fresh).toEqual({ id: mentor.id, role: 'MENTOR', mentorOnboardingSeenAt: null });
    await page.goto('/mentor');
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

    const localized = [
      { locale: 'en', title: 'Complete Your Profile', subtitle: 'Help us match you with the right mentor and opportunities' },
      { locale: 'tr', title: 'Profilini tamamla', subtitle: 'Seni doğru mentor ve fırsatlarla eşleştirmemize yardımcı ol' },
      { locale: 'de', title: 'Vervollständige dein Profil', subtitle: 'Hilf uns, dich mit dem passenden Mentor und den richtigen Möglichkeiten zusammenzubringen' },
    ];
    for (const { locale, title, subtitle } of localized) {
      await page.evaluate((value) => { document.cookie = `locale=${value};path=/`; }, locale);
      await page.goto('/onboarding');
      await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(subtitle, { exact: true })).toBeVisible();
    }
    await page.evaluate(() => { document.cookie = 'locale=en;path=/'; });
    await page.goto('/onboarding');
    await expect(page.getByLabel(/Full Name/i)).toHaveValue('Unchanged Mentee');
  } finally {
    await cleanupByEmail(email);
  }
});
