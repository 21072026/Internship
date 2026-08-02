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
  // Two participants, two clocks — each reminder must be rendered in the
  // recipient's own zone, never the server's (#1030).
  const ZONES: Record<string, string> = { [mentor.id]: 'Europe/Istanbul', [mentee.id]: 'Pacific/Honolulu' };
  await prisma.user.update({ where: { id: mentor.id }, data: { timezone: ZONES[mentor.id] } });
  await prisma.user.update({ where: { id: mentee.id }, data: { timezone: ZONES[mentee.id] } });
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const scheduledAt = new Date(Date.now() + 30 * 60 * 1000);
  const meeting = await prisma.meeting.create({
    data: {
      relationId: rel.id,
      title: 'Soon Meeting',
      // Inside the 60-minute reminder window (#777) — a meeting further out is
      // deliberately NOT reminded yet.
      scheduledAt,
      rsvpToken: randomBytes(12).toString('hex'),
      createdById: mentor.id,
    },
  });
  const farMeeting = await prisma.meeting.create({
    data: {
      relationId: rel.id,
      title: 'Later Meeting',
      scheduledAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
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

    // A meeting outside the 60-minute window is left alone.
    const later = await prisma.meeting.findUnique({ where: { id: farMeeting.id } });
    expect(later!.reminderSentAt).toBeNull();

    // In-app notification for BOTH participants, regardless of email prefs.
    for (const userId of [mentee.id, mentor.id]) {
      const notes = await prisma.notification.findMany({ where: { userId, type: 'meeting_reminder' } });
      expect(notes.length).toBe(1);
      expect(notes[0].text).toContain('Soon Meeting');
      // …and the time reads on the recipient's clock, not the server's.
      const timeZone = ZONES[userId];
      const expectedTime = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone }).format(scheduledAt);
      const expectedZone = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'shortOffset' })
        .formatToParts(scheduledAt)
        .find((p) => p.type === 'timeZoneName')!.value;
      expect(notes[0].text).toContain(expectedTime);
      expect(notes[0].text).toContain(`(${expectedZone})`);
    }

    // Idempotent: a second run must not produce a second reminder.
    const res2 = await page.request.get('/api/cron');
    expect(res2.ok()).toBeTruthy();
    for (const userId of [mentee.id, mentor.id]) {
      const notes = await prisma.notification.count({ where: { userId, type: 'meeting_reminder' } });
      expect(notes).toBe(1);
    }
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
