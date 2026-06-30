import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a user\'s activity is visible to admin and to their mentor, but not to strangers', async ({ page }) => {
  const adminEmail = uniqueEmail('pa-admin');
  const mentorEmail = uniqueEmail('pa-mentor');
  const strangerEmail = uniqueEmail('pa-stranger');
  const menteeEmail = uniqueEmail('pa-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'PA Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'PA Mentor');
  await seedUser(strangerEmail, 'StrangerPass123', 'MENTOR', 'PA Stranger');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'PA Mentee');
  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  await prisma.activityLog.create({ data: { action: 'auth.login', level: 'INFO', actorId: mentee.id, actorEmail: menteeEmail } });

  try {
    // Admin can read it.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
    const asAdmin = await (await page.request.get(`/api/users/${mentee.id}/activity`)).json();
    expect(asAdmin.items.some((i: { action: string }) => i.action === 'auth.login')).toBeTruthy();

    // The mentee's mentor can read it.
    await page.context().clearCookies();
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });
    const asMentor = await page.request.get(`/api/users/${mentee.id}/activity`);
    expect(asMentor.ok()).toBeTruthy();

    // An unrelated mentor cannot.
    await page.context().clearCookies();
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', strangerEmail);
    await page.fill('input[type="password"]', 'StrangerPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });
    const asStranger = await page.request.get(`/api/users/${mentee.id}/activity`);
    expect(asStranger.status()).toBe(403);
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorId: mentee.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(strangerEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
