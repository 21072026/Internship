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

test('stage deadlines flag overdue, surface on the calendar, and trigger reminders', async ({ page }) => {
  const adminEmail = uniqueEmail('dl-admin');
  const mentorEmail = uniqueEmail('dl-mentor');
  const menteeEmail = uniqueEmail('dl-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'DL Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'DL Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'DL Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    // Admin sets a stage deadline in the past.
    await signIn(page, adminEmail, 'AdminPass123', '/admin');
    const put = await page.request.put(`/api/mentorship/${rel.id}`, { data: { stageDeadline: '2020-01-01' } });
    expect(put.ok()).toBeTruthy();

    // Calendar shows it as an overdue deadline event.
    const cal = await (await page.request.get('/api/calendar-events')).json();
    const ev = cal.events.find((e: { id: string }) => e.id === `deadline-${rel.id}`);
    expect(ev).toBeTruthy();
    expect(ev.overdue).toBe(true);

    // Cron run reminds and marks the relation so it won't re-notify.
    const cron = await (await page.request.get('/api/cron')).json();
    expect(cron.deadlines.reminded).toBeGreaterThanOrEqual(1);
    const after = await prisma.mentorshipRelation.findUnique({ where: { id: rel.id } });
    expect(after?.deadlineReminderSentAt).toBeTruthy();

    // The mentor received an in-app deadline notification.
    await signIn(page, mentorEmail, 'MentorPass123', '/mentor');
    const notifs = await (await page.request.get('/api/notifications')).json();
    expect(notifs.items.some((n: { type: string }) => n.type === 'deadline')).toBeTruthy();
  } finally {
    await prisma.notification.deleteMany({ where: { userId: mentor.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
