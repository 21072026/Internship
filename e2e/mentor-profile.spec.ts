import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 20_000 });
}

test('mentor edits their own profile and profile API enforces role fields', async ({ browser }) => {
  const mentorEmail = uniqueEmail('mentor-profile');
  const menteeEmail = uniqueEmail('mentee-profile-guard');
  const otherEmail = uniqueEmail('profile-other');
  const password = 'ProfilePass123';
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Profile Mentor');
  await seedUser(menteeEmail, password, 'MENTEE', 'Profile Mentee');
  const other = await seedUser(otherEmail, password, 'MENTEE', 'Untouched User');

  const mentorContext = await browser.newContext();
  const menteeContext = await browser.newContext();
  try {
    const mentorPage = await mentorContext.newPage();
    await signIn(mentorPage, mentorEmail, password);
    await mentorPage.goto('/mentor/profile');

    await expect(mentorPage).toHaveURL(/\/mentor\/profile$/);
    await expect(mentorPage.locator('input[name="interests"]')).toBeVisible();
    await expect(mentorPage.locator('input[name="mentorCapacity"]')).toBeVisible();
    await expect(mentorPage.locator('input[name="languages"]')).toBeVisible();
    await expect(mentorPage.locator('input[name="university"]')).toHaveCount(0);
    await expect(mentorPage.locator('input[name="department"]')).toHaveCount(0);
    await expect(mentorPage.locator('[name="graduationYear"]')).toHaveCount(0);
    await expect(mentorPage.locator('input[name="targetPosition"]')).toHaveCount(0);
    await expect(mentorPage.locator('input[name="cvUrl"]')).toHaveCount(0);

    await mentorPage.locator('input[name="interests"]').fill('Frontend architecture');
    await mentorPage.locator('input[name="mentorCapacity"]').fill('7');
    await mentorPage.locator('input[name="languages"]').fill('English, Turkish, German');
    await mentorPage.locator('input[type="checkbox"]').check();
    await mentorPage.locator('button[type="submit"]').click();
    await expect.poll(async () => (await prisma.user.findUnique({ where: { id: mentor.id } }))?.mentorCapacity).toBe(7);
    await mentorPage.reload();
    await expect(mentorPage.locator('input[name="interests"]')).toHaveValue('Frontend architecture');
    await expect(mentorPage.locator('input[name="mentorCapacity"]')).toHaveValue('7');
    await expect(mentorPage.locator('input[name="languages"]')).toHaveValue('English, Turkish, German');

    const mentorProfile = await (await mentorPage.request.get('/api/profile')).json();
    expect(mentorProfile.user.publicProfile).toBe(true);
    expect(mentorProfile.user.interests).toBe('Frontend architecture');
    expect(mentorProfile.user.mentorCapacity).toBe(7);
    expect(mentorProfile.user.languages).toEqual(['English', 'Turkish', 'German']);

    for (const data of [
      { role: 'ADMIN' },
      { isActive: false },
      { userId: other.id, fullName: 'Changed by mentor' },
      { university: 'Not allowed' },
    ]) {
      const response = await mentorPage.request.put('/api/profile', { data });
      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(body.code).toBe('protected_fields');
      expect(body.fields).toContain(Object.keys(data)[0]);
    }
    expect((await prisma.user.findUnique({ where: { id: other.id } }))?.fullName).toBe('Untouched User');

    const menteePage = await menteeContext.newPage();
    await signIn(menteePage, menteeEmail, password);
    await menteePage.goto('/portal/profile');
    await expect(menteePage.locator('input[name="university"]')).toBeVisible();
    await expect(menteePage.locator('input[name="mentorCapacity"]')).toHaveCount(0);
    await expect(menteePage.locator('input[name="languages"]')).toHaveCount(0);

    const blocked = await menteePage.request.put('/api/profile', { data: { mentorCapacity: 3, languages: ['English'] } });
    expect(blocked.status()).toBe(403);
    await expect(blocked.json()).resolves.toMatchObject({ code: 'protected_fields', fields: ['mentorCapacity', 'languages'] });
  } finally {
    await mentorContext.close();
    await menteeContext.close();
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(otherEmail);
  }
});
