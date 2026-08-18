import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #668: an admin directly assigning a mentor to a mentee (no prior request)
// should create the MentorshipRelation and notify both sides in-app.
test('admin directly assigns a mentor to a mentee and both are notified in-app', async ({ page }) => {
  const adminEmail = uniqueEmail('assign-admin');
  const mentorEmail = uniqueEmail('assign-mentor');
  const menteeEmail = uniqueEmail('assign-mentee');
  const pw = 'AssignPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Assign Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Assign Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Assign Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/mentorship', {
      data: { mentorId: mentor.id, menteeId: mentee.id },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.relation.mentorId).toBe(mentor.id);
    expect(body.relation.menteeId).toBe(mentee.id);

    const relation = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: mentee.id },
    });
    expect(relation).toBeTruthy();

    // notify() calls in src/app/api/mentorship/route.ts emit
    // 'mentorship_request.menteeAssigned' (mentor) and 'mentorship_request.mentorAssigned' (mentee).
    await expect
      .poll(async () => prisma.notification.count({ where: { userId: mentor.id, type: 'mentorship_request.menteeAssigned' } }), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => prisma.notification.count({ where: { userId: mentee.id, type: 'mentorship_request.mentorAssigned' } }), { timeout: 10_000 })
      .toBeGreaterThan(0);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id, menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
