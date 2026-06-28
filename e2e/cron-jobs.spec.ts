import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin cron run sends meeting reminders and stamps reminderSentAt', async ({ page }) => {
  const adminEmail = uniqueEmail('cronadmin');
  const mentorEmail = uniqueEmail('cronmentor');
  const menteeEmail = uniqueEmail('cronmentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Cron Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Cron Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Cron Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const meeting = await prisma.meeting.create({
    data: {
      relationId: rel.id,
      title: 'Soon Meeting',
      scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      rsvpToken: randomBytes(12).toString('hex'),
      createdById: mentor.id,
    },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.get('/api/cron');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.meetings.reminded).toBeGreaterThanOrEqual(1);

    const after = await prisma.meeting.findUnique({ where: { id: meeting.id } });
    expect(after!.reminderSentAt).not.toBeNull();
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
