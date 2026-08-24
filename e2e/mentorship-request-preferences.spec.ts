import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #939 (story #900): matching preferences on a mentorship request. A mentee
// can state a preferred field, preferred languages and a preferred mentor —
// the latter only from the consent-gated directory (publicProfile + active
// MENTOR_DIRECTORY_VISIBILITY consent, same visibility rule as GET
// /api/mentors). Admins see the preferences in the queue as advisory chips;
// the preferred mentor merely preselects the picker, never binds it.

async function signIn(page: Page, email: string, password: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

// Complete the onboarding gate (#591) for a seeded mentee: profile + CV.
async function completeOnboarding(menteeId: string) {
  await prisma.user.update({ where: { id: menteeId }, data: { university: 'Test University', skills: ['React'] } });
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: menteeId, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });
}

// A mentor a mentee can actually see in the directory: publicProfile opt-in
// AND an active MENTOR_DIRECTORY_VISIBILITY consent (#937).
async function makeDirectoryVisible(mentorId: string) {
  await prisma.user.update({ where: { id: mentorId }, data: { publicProfile: true } });
  await prisma.userConsent.create({
    data: { userId: mentorId, type: 'MENTOR_DIRECTORY_VISIBILITY', grantedAt: new Date() },
  });
}

test('mentee submits a request with field/language/mentor preferences and sees them persisted', async ({ page }) => {
  const menteeEmail = uniqueEmail('pref-mentee');
  const mentorEmail = uniqueEmail('pref-mentor');
  const pw = 'PrefPass123';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Pref Mentee');
  await completeOnboarding(mentee.id);
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Pref Visible Mentor');
  await makeDirectoryVisible(mentor.id);

  try {
    await signIn(page, menteeEmail, pw, '/portal');

    const created = await page.request.post('/api/mentorship-requests', {
      data: {
        message: 'Looking for a backend mentor.',
        preferredField: 'Backend Development',
        preferredLanguages: ['Turkish', 'English'],
        preferredMentorId: mentor.id,
      },
    });
    expect(created.status()).toBe(201);
    const requestId = (await created.json()).request.id;

    // Persisted with all three preferences.
    const stored = await prisma.mentorshipRequest.findUnique({ where: { id: requestId } });
    expect(stored?.preferredField).toBe('Backend Development');
    expect(stored?.preferredLanguages).toEqual(['Turkish', 'English']);
    expect(stored?.preferredMentorId).toBe(mentor.id);

    // The mentee's own GET echoes them back (no email/phone anywhere).
    const list = await (await page.request.get('/api/mentorship-requests')).json();
    const mine = (list.requests as {
      id: string;
      preferredField?: string | null;
      preferredLanguages?: string[];
      preferredMentor?: { id: string; fullName: string } | null;
    }[]).find((r) => r.id === requestId);
    expect(mine?.preferredField).toBe('Backend Development');
    expect(mine?.preferredLanguages).toEqual(['Turkish', 'English']);
    expect(mine?.preferredMentor).toEqual({ id: mentor.id, fullName: 'Pref Visible Mentor' });
  } finally {
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('a preferred mentor who is not directory-visible is rejected with invalid_preferred_mentor', async ({ page }) => {
  const menteeEmail = uniqueEmail('pref-inv-mentee');
  const mentorEmail = uniqueEmail('pref-inv-mentor');
  const pw = 'PrefPass123';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Pref Invalid Mentee');
  await completeOnboarding(mentee.id);
  // Deliberately NOT directory-visible: no publicProfile, no consent.
  const hiddenMentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Pref Hidden Mentor');

  try {
    await signIn(page, menteeEmail, pw, '/portal');

    const res = await page.request.post('/api/mentorship-requests', {
      data: { preferredMentorId: hiddenMentor.id },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('invalid_preferred_mentor');

    // Nothing was created.
    expect(await prisma.mentorshipRequest.count({ where: { menteeId: mentee.id } })).toBe(0);
  } finally {
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('admin queue returns the preferences and renders chips with the preferred mentor preselected', async ({ page }) => {
  const menteeEmail = uniqueEmail('pref-admin-mentee');
  const adminEmail = uniqueEmail('pref-admin-admin');
  const mentorEmail = uniqueEmail('pref-admin-mentor');
  const pw = 'PrefPass123';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Pref Queue Mentee');
  await seedUser(adminEmail, pw, 'ADMIN', 'Pref Queue Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Pref Queue Mentor');
  await makeDirectoryVisible(mentor.id);

  // Seed the request directly — this test is about the admin surface, not the
  // submission gate (covered above).
  const request = await prisma.mentorshipRequest.create({
    data: {
      menteeId: mentee.id,
      message: 'Preferences please.',
      preferredField: 'Data Engineering',
      preferredLanguages: ['German'],
      preferredMentorId: mentor.id,
    },
  });

  try {
    await signIn(page, adminEmail, pw, '/admin');

    // API: the queue listing carries all three preferences.
    const list = await (await page.request.get('/api/admin/mentorship-requests')).json();
    const row = (list.requests as {
      id: string;
      preferredField?: string | null;
      preferredLanguages?: string[];
      preferredMentor?: { id: string; fullName: string } | null;
    }[]).find((r) => r.id === request.id);
    expect(row).toBeTruthy();
    expect(row?.preferredField).toBe('Data Engineering');
    expect(row?.preferredLanguages).toEqual(['German']);
    expect(row?.preferredMentor).toEqual({ id: mentor.id, fullName: 'Pref Queue Mentor' });

    // UI: chips under the message and the mentor select preselected —
    // everything scoped to this request's row (other tests' rows may coexist).
    await page.goto('/admin/mentorship');
    const rowLocator = page.getByTestId(`request-${request.id}`);
    await expect(rowLocator).toBeVisible({ timeout: 15_000 });

    const chips = rowLocator.getByTestId('request-preferences');
    await expect(chips).toBeVisible();
    await expect(chips).toContainText('Data Engineering');
    await expect(chips).toContainText('German');
    await expect(chips).toContainText('Pref Queue Mentor');

    // Preselected, non-binding: the row's mentor <select> already holds the
    // preferred mentor's id (its option list loads async with the pickers).
    await expect(rowLocator.locator('select')).toHaveValue(mentor.id, { timeout: 15_000 });
  } finally {
    await prisma.mentorshipRequest.deleteMany({ where: { id: request.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
