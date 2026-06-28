import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentor schedules a meeting and the mentee can RSVP via the public link', async ({ page }) => {
  const mentorEmail = uniqueEmail('meetmentor');
  const menteeEmail = uniqueEmail('meetmentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Meeting Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Meeting Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto('/mentor/meetings');
    await page.getByText('Meeting Mentee').click(); // toggles the recipient checkbox
    await page.getByLabel('Title').fill('Kickoff call');
    await page.getByLabel('When').fill('2026-07-01T10:00');
    const scheduled = page.waitForResponse(
      (r) => r.url().includes('/api/meetings') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Send invite' }).click();
    await scheduled;
    await expect(page.getByText(/Invite sent to 1/)).toBeVisible({ timeout: 10_000 });

    const meeting = await prisma.meeting.findFirst({ where: { relationId: rel.id } });
    expect(meeting).not.toBeNull();

    // Mentee responds via the public RSVP link (no auth).
    await page.context().clearCookies();
    await page.goto(`/rsvp/${meeting!.rsvpToken}`);
    const responded = page.waitForResponse(
      (r) => r.url().includes('/api/rsvp') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /Yes, I'll attend/ }).click();
    await responded;
    await expect(page.getByText(/attendance is confirmed/i)).toBeVisible({ timeout: 10_000 });

    const after = await prisma.meeting.findUnique({ where: { id: meeting!.id } });
    expect(after!.rsvp).toBe('ACCEPTED');
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
