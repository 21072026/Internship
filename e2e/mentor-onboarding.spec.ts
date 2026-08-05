import { test, expect } from '@playwright/test';
import { prisma, seedInvite, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const password = 'MentorOnboard123!';

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an invited mentor account starts pending while the schema default remains completed', async ({ request }) => {
  const invitedEmail = uniqueEmail('mentor-onboarding-invite');
  const defaultEmail = uniqueEmail('mentor-onboarding-default');
  const token = await seedInvite(invitedEmail, 'MENTOR');
  try {
    const response = await request.post('/api/register', {
      data: { token, email: invitedEmail, password, fullName: 'Invited Mentor', consent: true },
    });
    expect(response.status()).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: invitedEmail } })).mentorOnboardingStatus).toBe('PENDING');

    const existingStyleMentor = await seedUser(defaultEmail, password, 'MENTOR', 'Default Mentor');
    expect(existingStyleMentor.mentorOnboardingStatus).toBe('COMPLETED');
  } finally {
    await cleanupByEmail(defaultEmail);
    await cleanupByEmail(invitedEmail);
  }
});

test('a pending mentor can skip onboarding and is not forced back on the next visit', async ({ page }) => {
  const email = uniqueEmail('mentor-onboarding-skip');
  const mentor = await seedUser(email, password, 'MENTOR', 'Skip Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorOnboardingStatus: 'PENDING' } });
  try {
    await signIn(page, email);
    await page.waitForURL('**/onboarding');
    await expect(page.getByTestId('mentor-onboarding-wizard')).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await page.waitForURL((url) => url.pathname === '/mentor');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: mentor.id } })).mentorOnboardingStatus).toBe('SKIPPED');
    await expect(page.getByTestId('mentor-profile-checklist')).toBeVisible();

    await page.goto('/mentor');
    await expect(page).toHaveURL(/\/mentor$/);
  } finally {
    await cleanupByEmail(email);
  }
});

test('mentor completes four steps, saves capacity zero and multiple availability slots', async ({ page }) => {
  const email = uniqueEmail('mentor-onboarding-complete');
  const mentor = await seedUser(email, password, 'MENTOR', 'Complete Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorOnboardingStatus: 'PENDING' } });
  try {
    await signIn(page, email);
    await page.waitForURL('**/onboarding');
    const wizard = page.getByTestId('mentor-onboarding-wizard');
    await expect(wizard.getByText('Profile', { exact: true })).toBeVisible();
    await wizard.locator('textarea').fill('Mentor biography');
    await wizard.getByRole('button', { name: 'Continue' }).click();
    await wizard.locator('textarea').fill('Frontend mentoring');
    await wizard.getByLabel('Skills').fill('React, TypeScript');
    await wizard.getByRole('button', { name: 'Continue' }).click();
    await wizard.getByLabel('Mentee capacity').fill('0');
    await wizard.getByRole('button', { name: 'Continue' }).click();
    await wizard.getByRole('button', { name: 'Add slot' }).click();
    await expect(wizard.getByTestId('mentor-onboarding-slot')).toHaveCount(2);
    await wizard.getByRole('button', { name: 'Finish' }).click();
    await page.waitForURL((url) => url.pathname === '/mentor');

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: mentor.id } });
    expect(stored.mentorOnboardingStatus).toBe('COMPLETED');
    expect(stored.bio).toBe('Mentor biography');
    expect(stored.interests).toBe('Frontend mentoring');
    expect(stored.skills).toEqual(['React', 'TypeScript']);
    expect(stored.mentorCapacity).toBe(0);
    expect(await prisma.availabilitySlot.count({ where: { mentorId: mentor.id } })).toBe(2);
    await expect(page.getByTestId('mentor-profile-checklist')).toHaveCount(0);
  } finally {
    await prisma.availabilitySlot.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(email);
  }
});

test('batch availability validation is atomic and mentor-only', async ({ page }) => {
  const mentorEmail = uniqueEmail('mentor-onboarding-batch');
  const menteeEmail = uniqueEmail('mentee-onboarding-batch');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Batch Mentor');
  await seedUser(menteeEmail, password, 'MENTEE', 'Batch Mentee');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorOnboardingStatus: 'SKIPPED' } });
  try {
    await signIn(page, mentorEmail);
    await page.waitForURL((url) => url.pathname === '/mentor');
    for (const slots of [
      [{ weekday: 7, startTime: '09:00', endTime: '10:00' }],
      [{ weekday: 1, startTime: '10:00', endTime: '09:00' }],
      [{ weekday: 1, startTime: '09:00', endTime: '10:00' }, { weekday: 1, startTime: '09:00', endTime: '10:00' }],
    ]) {
      const response = await page.request.post('/api/availability', { data: { slots } });
      expect(response.ok()).toBeFalsy();
      expect(await prisma.availabilitySlot.count({ where: { mentorId: mentor.id } })).toBe(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: mentor.id } })).mentorOnboardingStatus).toBe('SKIPPED');
    }

    const foreign = await page.request.post('/api/availability', {
      data: { userId: 'another-user', slots: [{ weekday: 1, startTime: '09:00', endTime: '10:00' }] },
    });
    expect(foreign.status()).toBe(400);

    await page.context().clearCookies();
    await signIn(page, menteeEmail);
    await page.waitForURL((url) => url.pathname === '/portal');
    expect((await page.request.put('/api/onboarding', { data: { action: 'skip' } })).status()).toBe(403);
    expect((await page.request.post('/api/availability', { data: { slots: [{ weekday: 1, startTime: '09:00', endTime: '10:00' }] } })).status()).toBe(401);
  } finally {
    await prisma.availabilitySlot.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('mentor profile checklist treats whitespace as empty and zero capacity as complete', async ({ page }) => {
  const email = uniqueEmail('mentor-onboarding-checklist');
  const mentor = await seedUser(email, password, 'MENTOR', 'Checklist Mentor');
  await prisma.user.update({
    where: { id: mentor.id },
    data: { mentorOnboardingStatus: 'SKIPPED', bio: '   ', interests: '\n', skills: [], mentorCapacity: 0 },
  });
  try {
    await signIn(page, email);
    await page.waitForURL((url) => url.pathname === '/mentor');
    const checklist = page.getByTestId('mentor-profile-checklist');
    await expect(checklist.getByText('Complete your mentor profile')).toBeVisible();
    await expect(checklist.getByText('Add your expertise and skills')).toBeVisible();
    await expect(checklist.getByText('Set your mentoring capacity')).toHaveClass(/line-through/);

    await prisma.user.update({ where: { id: mentor.id }, data: { bio: 'Bio', interests: 'Web', skills: ['React'] } });
    await prisma.availabilitySlot.create({ data: { mentorId: mentor.id, weekday: 1, startTime: '09:00', endTime: '10:00' } });
    await page.reload();
    await expect(page.getByTestId('mentor-profile-checklist')).toHaveCount(0);
  } finally {
    await prisma.availabilitySlot.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(email);
  }
});
