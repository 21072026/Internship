import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentee portal shows a journey tracker reflecting the pipeline stage', async ({ page }) => {
  const mentorEmail = uniqueEmail('jt-mentor');
  const menteeEmail = uniqueEmail('jt-mentee');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'JT Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'JT Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  const tag = rel.id.slice(-8);
  const titledSubject = `Weekly progress ${tag} ${'with a deliberately long subject '.repeat(3)}`;
  const titledNotes = `Titled interaction notes ${tag}`;
  const subjectlessNotes = `Subjectless interaction notes ${tag}`;
  await prisma.interactionLog.createMany({
    data: [
      {
        relationId: rel.id,
        date: new Date('2026-08-02T12:00:00Z'),
        subject: titledSubject,
        notes: titledNotes,
        type: 'Meeting',
      },
      {
        relationId: rel.id,
        date: new Date('2026-08-01T12:00:00Z'),
        notes: subjectlessNotes,
        type: 'Feedback',
      },
    ],
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/portal/interactions');
    await expect(page.getByText(titledSubject, { exact: true })).toBeVisible();
    await expect(page.getByText(titledNotes, { exact: true })).toBeVisible();
    const subjectlessHistoryNotes = page.getByText(subjectlessNotes, { exact: true });
    await expect(subjectlessHistoryNotes).toBeVisible();
    await expect(subjectlessHistoryNotes.locator('..').locator(':scope > p')).toHaveCount(2);

    // The journey tracker moved off the dashboard to its own page (#692);
    // /portal now only links there, so "My journey" matches several elements.
    await page.goto('/portal/journey');
    // Both the page h1 and the tracker card's h3 say "My journey" — pin the h1.
    await expect(page.getByRole('heading', { level: 1, name: /My journey/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Internship in progress/i).first()).toBeVisible();
    // Actionable "what to do now" guidance for the current stage.
    await expect(page.getByText(/What to do now/i)).toBeVisible();
    await expect(page.getByText(/Log your progress regularly/i)).toBeVisible();

    const journeySubject = page.getByText(titledSubject, { exact: true });
    await expect(journeySubject).toBeVisible();
    await expect(page.getByText(titledNotes, { exact: true })).toBeVisible();
    const subjectlessJourneyNotes = page.getByText(subjectlessNotes, { exact: true });
    await expect(subjectlessJourneyNotes).toBeVisible();
    await expect(subjectlessJourneyNotes.locator('..').locator(':scope > p')).toHaveCount(2);
    await expect(journeySubject).toHaveClass(/truncate/);
    await expect(journeySubject.locator('..')).toHaveClass(/min-w-0/);

    await page.setViewportSize({ width: 375, height: 812 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(376);
    expect(await journeySubject.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
