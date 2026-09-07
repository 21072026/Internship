import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

// The stage clock (#1724): the mentor is told how long a card has been sitting
// in its stage (and loudly when the org's stage deadline has passed), while the
// mentee sees the same number with none of that language.
//
// The relation is seeded with a startDate 60 days back and a recorded stage
// move 12 days back, so a correct implementation must read the LAST MOVE, not
// the relation's start — 60 would be the wrong answer.

const DAY = 24 * 60 * 60 * 1000;

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('stage clock: mentor sees days-in-stage and an overdue state, the mentee sees neither', async ({ page }) => {
  const mentorEmail = uniqueEmail('clock-mentor');
  const menteeEmail = uniqueEmail('clock-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Clock Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Clock Mentee');

  const rel = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      status: 'ACTIVE',
      pipelineStatus: 'INTERVIEW_PENDING_250',
      startDate: new Date(Date.now() - 60 * DAY),
    },
  });
  await prisma.statusChange.create({
    data: {
      relationId: rel.id,
      fromStatus: 'APPLICATION_100',
      toStatus: 'INTERVIEW_PENDING_250',
      changedById: mentor.id,
      createdAt: new Date(Date.now() - 12 * DAY - 60_000),
    },
  });

  try {
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');

    // The API carries the number, inside the mentor's own scope.
    const rows = (await (await page.request.get('/api/mentorship')).json()).relations as {
      id: string;
      daysInStage: number;
    }[];
    const row = rows.find((r) => r.id === rel.id);
    expect(row?.daysInStage).toBe(12);

    // Board card: 12 days, and no alarm yet — no deadline is configured and 12
    // is well under the fallback attention threshold.
    await page.goto('/mentor/board');
    const chip = page.getByTestId(`stage-clock-${rel.id}`);
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('12');
    await expect(chip).toHaveAttribute('data-stage-clock-tone', 'normal');

    // Once the org's stage deadline has passed, the same chip turns overdue.
    await prisma.mentorshipRelation.update({
      where: { id: rel.id },
      data: { stageDeadline: new Date(Date.now() - 3 * DAY) },
    });
    await page.reload();
    await expect(chip).toHaveAttribute('data-stage-clock-tone', 'overdue', { timeout: 15_000 });
    await expect(chip).toContainText('12');

    // A terminal stage never reads as overdue, however stale the deadline is.
    await prisma.mentorshipRelation.update({ where: { id: rel.id }, data: { pipelineStatus: 'EMPLOYED_700' } });
    await page.reload();
    await expect(chip).toHaveAttribute('data-stage-clock-tone', 'normal', { timeout: 15_000 });
    await prisma.mentorshipRelation.update({
      where: { id: rel.id },
      data: { pipelineStatus: 'INTERVIEW_PENDING_250' },
    });

    // Mentee side: the same clock, deliberately with no breach state — the
    // deadline is still three days in the past at this point.
    await signInAsFreshUser(page, menteeEmail, 'MenteePass123', '/portal');
    const clock = page.getByTestId('portal-stage-clock');
    await expect(clock).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('portal-stage-clock-days')).toContainText('12');
    await expect(clock).not.toContainText(/overdue|gecik|überfällig/i);
  } finally {
    await prisma.statusChange.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
