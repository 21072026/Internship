import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { getMentorAvailability } from '../src/lib/mentorAvailability';

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

// #941: a mentor can read and write their own acceptingMentees preference
// through /api/profile; it never affects another mentor's row, and a mentee
// (or anyone else) is blocked from setting it — same MENTOR_ONLY_FIELDS guard
// mentorCapacity already uses.
test('mentor reads and writes their own acceptingMentees; other roles are blocked', async ({ browser }) => {
  const mentorEmail = uniqueEmail('accepting-mentor');
  const otherMentorEmail = uniqueEmail('accepting-other-mentor');
  const menteeEmail = uniqueEmail('accepting-mentee-guard');
  const password = 'AcceptingPass123';
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Accepting Mentor');
  const otherMentor = await seedUser(otherMentorEmail, password, 'MENTOR', 'Other Mentor');
  await seedUser(menteeEmail, password, 'MENTEE', 'Accepting Mentee Guard');

  const mentorContext = await browser.newContext();
  const menteeContext = await browser.newContext();
  try {
    const mentorPage = await mentorContext.newPage();
    await signIn(mentorPage, mentorEmail, password);

    // Starts unset (null) — no preference recorded yet.
    const initial = await (await mentorPage.request.get('/api/profile')).json();
    expect(initial.user.acceptingMentees).toBeNull();

    const setTrue = await mentorPage.request.put('/api/profile', { data: { acceptingMentees: true } });
    expect(setTrue.ok()).toBeTruthy();
    expect((await setTrue.json()).user.acceptingMentees).toBe(true);
    expect((await prisma.user.findUnique({ where: { id: mentor.id } }))?.acceptingMentees).toBe(true);

    const setFalse = await mentorPage.request.put('/api/profile', { data: { acceptingMentees: false } });
    expect((await setFalse.json()).user.acceptingMentees).toBe(false);

    // A GET right after reflects the explicit opt-out as 'not_accepting' —
    // proves the real endpoint reaches that branch, not just the pure helper.
    const afterFalse = await (await mentorPage.request.get('/api/profile')).json();
    expect(afterFalse.user.availability.status).toBe('not_accepting');

    // Explicit null clears the preference back to "not set".
    const cleared = await mentorPage.request.put('/api/profile', { data: { acceptingMentees: null } });
    expect((await cleared.json()).user.acceptingMentees).toBeNull();

    // The other mentor's row is untouched by any of the above.
    expect((await prisma.user.findUnique({ where: { id: otherMentor.id } }))?.acceptingMentees).toBeNull();

    const menteePage = await menteeContext.newPage();
    await signIn(menteePage, menteeEmail, password);
    const blocked = await menteePage.request.put('/api/profile', { data: { acceptingMentees: true } });
    expect(blocked.status()).toBe(403);
    await expect(blocked.json()).resolves.toMatchObject({ code: 'protected_fields', fields: ['acceptingMentees'] });
  } finally {
    await mentorContext.close();
    await menteeContext.close();
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(otherMentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

// #941: /api/profile's GET reports the mentor's activeMenteeCount and a
// derived availability, both computed server-side via the shared helper —
// counting only ACTIVE relations, and never present for non-mentors.
test('mentor profile GET reports activeMenteeCount and availability from ACTIVE relations only', async ({ browser }) => {
  const mentorEmail = uniqueEmail('avail-mentor');
  const menteeAEmail = uniqueEmail('avail-mentee-a');
  const menteeBEmail = uniqueEmail('avail-mentee-b');
  const menteeCEmail = uniqueEmail('avail-mentee-c');
  const password = 'AvailPass123';
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Availability Mentor');
  const menteeA = await seedUser(menteeAEmail, password, 'MENTEE', 'Avail Mentee A');
  const menteeB = await seedUser(menteeBEmail, password, 'MENTEE', 'Avail Mentee B');
  const menteeC = await seedUser(menteeCEmail, password, 'MENTEE', 'Avail Mentee C');

  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: menteeA.id, status: 'ACTIVE' } });
  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: menteeB.id, status: 'ACTIVE' } });
  // COMPLETED — must NOT be counted in activeMenteeCount.
  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: menteeC.id, status: 'COMPLETED' } });

  const mentorContext = await browser.newContext();
  const menteeContext = await browser.newContext();
  try {
    const mentorPage = await mentorContext.newPage();
    await signIn(mentorPage, mentorEmail, password);
    await mentorPage.request.put('/api/profile', { data: { mentorCapacity: 2, acceptingMentees: true } });

    const { user } = await (await mentorPage.request.get('/api/profile')).json();
    // Two ACTIVE relations counted; the COMPLETED one is excluded.
    expect(user.activeMenteeCount).toBe(2);

    // The response's availability must match the shared helper's own output
    // for the same inputs exactly — proves the API reuses it instead of
    // re-deriving the status independently.
    const expected = getMentorAvailability({ mentorCapacity: 2, activeMenteeCount: 2, acceptingMentees: true });
    expect(user.availability).toEqual(expected);
    expect(user.availability.status).toBe('at_capacity');

    // A mentee's own profile response is unchanged — no activeMenteeCount/availability.
    const menteePage = await menteeContext.newPage();
    await signIn(menteePage, menteeAEmail, password);
    const { user: menteeUser } = await (await menteePage.request.get('/api/profile')).json();
    expect(menteeUser.activeMenteeCount).toBeUndefined();
    expect(menteeUser.availability).toBeUndefined();
  } finally {
    await mentorContext.close();
    await menteeContext.close();
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeAEmail);
    await cleanupByEmail(menteeBEmail);
    await cleanupByEmail(menteeCEmail);
  }
});
