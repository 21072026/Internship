import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('scheduling a meeting without a link auto-generates a video room link', async ({ page }) => {
  const mentorEmail = uniqueEmail('aml-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'AML Mentor');
  const mentee = await seedUser(uniqueEmail('aml-mentee'), 'x', 'MENTEE', 'AML Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const res = await page.request.post('/api/meetings', {
      data: { relationIds: [rel.id], title: 'Intro call', scheduledAt: '2026-09-01T10:00:00.000Z', meetLink: '' },
    });
    expect(res.ok()).toBeTruthy();

    const meeting = await prisma.meeting.findFirst({ where: { relationId: rel.id } });
    expect(meeting?.meetLink).toBeTruthy();
    expect(meeting?.meetLink).toContain('meet.jit.si');
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
  }
});
