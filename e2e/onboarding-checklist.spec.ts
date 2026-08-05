import { test, expect } from '@playwright/test';
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
    await expect(checklist.getByText('Write a short bio')).toBeVisible();
    await expect(checklist.getByText('Add your interests or skills')).toBeVisible();
    await expect(checklist.getByText('Set your mentee capacity')).toBeVisible();
    await expect(checklist.getByText('Add an availability slot')).toBeVisible();
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
