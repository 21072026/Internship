import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string, home: string) {
  await page.context().clearCookies();
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

test('mentee requests a meeting and the mentor accepting creates a meeting', async ({ page }) => {
  const mentorEmail = uniqueEmail('mr-mentor');
  const menteeEmail = uniqueEmail('mr-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'MR Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'MR Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  let reqId = '';

  try {
    // Mentee requests a meeting.
    await signIn(page, menteeEmail, 'MenteePass123', '/portal');
    const created = await page.request.post('/api/meeting-requests', {
      data: { relationId: rel.id, topic: 'Career advice', proposedAt: new Date(Date.now() + 86400000).toISOString() },
    });
    expect(created.status()).toBe(201);
    reqId = (await created.json()).request.id;

    // Mentor accepts → a Meeting is created and the request is ACCEPTED.
    await signIn(page, mentorEmail, 'MentorPass123', '/mentor');
    const accept = await page.request.patch(`/api/meeting-requests/${reqId}`, { data: { action: 'accept' } });
    expect(accept.ok()).toBeTruthy();
    expect((await accept.json()).status).toBe('ACCEPTED');

    const meeting = await prisma.meeting.findFirst({ where: { relationId: rel.id, title: 'Career advice' } });
    expect(meeting).toBeTruthy();
    expect(meeting?.meetLink).toContain('meet.jit.si');
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.meetingRequest.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
