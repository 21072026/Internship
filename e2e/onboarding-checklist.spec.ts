import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a fresh mentee sees the first-run checklist on the dashboard', async ({ page }) => {
  const email = uniqueEmail('checklist');
  await seedUser(email, 'CheckPass123', 'MENTEE', 'Checklist Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'CheckPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible({ timeout: 10_000 });
    // Scope to the checklist card — the mentorship-request gate box (#591) also
    // renders an "Upload your CV" link on the same dashboard.
    const checklist = page.getByTestId('onboarding-checklist');
    await expect(checklist.getByText('Upload your CV')).toBeVisible();
    await expect(checklist.getByText('Make your profile public')).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});

test('a fresh mentor sees the profile/availability checklist on the dashboard (#912)', async ({ page }) => {
  const email = uniqueEmail('checklist-mentor');
  await seedUser(email, 'CheckPass123', 'MENTOR', 'Checklist Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'CheckPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible({ timeout: 10_000 });
    const checklist = page.getByTestId('onboarding-checklist');
    await expect(checklist.getByTestId('onboarding-step-bio')).toBeVisible();
    await expect(checklist.getByTestId('onboarding-step-interestsOrSkills')).toBeVisible();
    await expect(checklist.getByTestId('onboarding-step-mentorCapacity')).toBeVisible();
    await expect(checklist.getByTestId('onboarding-step-availability')).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});

test('the mentor checklist hides once bio, skills, capacity and availability are all set (#912)', async ({ page }) => {
  const email = uniqueEmail('checklist-mentor-done');
  const mentor = await seedUser(email, 'CheckPass123', 'MENTOR', 'Done Mentor');
  await prisma.user.update({
    where: { id: mentor.id },
    data: { bio: 'I love mentoring.', skills: ['React'], mentorCapacity: 3 },
  });
  await prisma.availabilitySlot.create({
    data: { mentorId: mentor.id, weekday: 1, startTime: '09:00', endTime: '10:00' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'CheckPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await expect(page.getByTestId('onboarding-checklist')).toHaveCount(0);
  } finally {
    await prisma.availabilitySlot.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(email);
  }
});

// --- #2068: the expanded ADMIN launch list + server-side dismissal -----------

async function signIn(page: Page, email: string, password: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

test('a fresh admin sees the whole launch list, with a guide behind each step (#2068)', async ({ page }) => {
  const email = uniqueEmail('checklist-admin');
  await seedUser(email, 'CheckPass123', 'ADMIN', 'Checklist Admin');

  try {
    await signIn(page, email, 'CheckPass123', '/admin');
    const checklist = page.getByTestId('onboarding-checklist');
    await expect(checklist).toBeVisible({ timeout: 10_000 });
    for (const key of [
      'configurePipeline',
      'setStageSlas',
      'documentRequirements',
      'evaluationTemplate',
      'inviteMentors',
      'inviteMentees',
      'addCompany',
      'assignMentorship',
      'firstInteraction',
    ]) {
      await expect(checklist.getByTestId(`onboarding-step-${key}`)).toBeVisible();
    }
    // The guide stays collapsed until it is asked for.
    await expect(checklist.getByTestId('onboarding-guide-setStageSlas')).toHaveCount(0);
    await checklist.getByTestId('onboarding-guide-toggle-setStageSlas').click();
    await expect(checklist.getByTestId('onboarding-guide-setStageSlas')).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});

test('a dismissal survives a fresh browser and closes nobody else’s checklist (#2068)', async ({ browser }) => {
  const email = uniqueEmail('checklist-dismiss');
  const otherEmail = uniqueEmail('checklist-other');
  const dismisser = await seedUser(email, 'CheckPass123', 'ADMIN', 'Dismissing Admin');
  const other = await seedUser(otherEmail, 'CheckPass123', 'ADMIN', 'Other Admin');

  const first = await browser.newContext();
  const second = await browser.newContext();
  const third = await browser.newContext();
  try {
    const page = await first.newPage();
    await signIn(page, email, 'CheckPass123', '/admin');
    await expect(page.getByTestId('onboarding-checklist')).toBeVisible({ timeout: 10_000 });

    // A body naming somebody else is rejected outright: the handler takes the
    // user from the session and accepts no other field.
    const spoofed = await page.request.post('/api/onboarding/dismiss', {
      data: { userId: other.id, dismissed: true },
    });
    expect(spoofed.status()).toBe(400);

    await page.getByTestId('onboarding-checklist').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('onboarding-checklist')).toHaveCount(0);
    await expect
      .poll(() =>
        prisma.userGuidanceState.count({
          where: { userId: dismisser.id, dismissedAt: { not: null } },
        })
      )
      .toBe(1);

    // A different browser: empty localStorage, so only the server can know.
    const clean = await second.newPage();
    await signIn(clean, email, 'CheckPass123', '/admin');
    await expect(clean.getByTestId('onboarding-checklist')).toHaveCount(0);

    // The other admin is untouched — no row, and the card still shows.
    const otherPage = await third.newPage();
    await signIn(otherPage, otherEmail, 'CheckPass123', '/admin');
    await expect(otherPage.getByTestId('onboarding-checklist')).toBeVisible({ timeout: 10_000 });
    expect(await prisma.userGuidanceState.count({ where: { userId: other.id } })).toBe(0);
  } finally {
    await first.close();
    await second.close();
    await third.close();
    await cleanupByEmail(email);
    await cleanupByEmail(otherEmail);
  }
});
