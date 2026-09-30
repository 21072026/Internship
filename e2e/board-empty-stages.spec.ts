import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1366: the mentor board drew all 13 stages at full width, so on a 1280px
// screen a mentor saw four columns — mostly empty — and their own mentees sat
// two screens to the right. Empty stages now collapse to a strip that is still
// a drop target, a toggle brings them back, and the header counts the board.

const PASSWORD = 'BoardEmpty123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.use({ viewport: { width: 1280, height: 900 } });

test('a mentor sees mentees in three stages at once; empty stages are strips that still take a drop', async ({ page }) => {
  const mentorEmail = uniqueEmail('board-empty-mentor');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Board Empty Mentor');
  const seeded = [
    { name: 'Aylin Applicant', stage: 'APPLICATION_100' },
    { name: 'Berk Intern', stage: 'INTERNSHIP_IN_PROGRESS_450' },
    { name: 'Cemre Hired', stage: 'HIRED_660' },
  ];
  const emails: string[] = [];
  const relationIds: string[] = [];
  for (const s of seeded) {
    const email = uniqueEmail('board-empty-mentee');
    emails.push(email);
    const mentee = await seedUser(email, 'x', 'MENTEE', s.name);
    const rel = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: s.stage },
    });
    relationIds.push(rel.id);
  }

  try {
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
    await page.goto('/mentor/board');
    await expect(page.getByTestId('board-columns')).toBeVisible({ timeout: 20_000 });

    // All three mentees are on screen on first load — no horizontal hunt.
    for (const s of seeded) {
      await expect(page.getByTestId('board-card').filter({ hasText: s.name })).toBeInViewport();
    }
    await expect(page.getByTestId('board-total')).toHaveText('3 on the board');

    // Empty stages are strips; occupied ones are full columns.
    await expect(page.getByTestId('board-column-INTERVIEW_PENDING_250')).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('board-column-APPLICATION_100')).not.toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('board-column-count-INTERVIEW_PENDING_250')).toHaveText('0');

    // A collapsed strip is still a drop target: the card moves there.
    await page
      .getByTestId('board-card')
      .filter({ hasText: 'Aylin Applicant' })
      .dragTo(page.getByTestId('board-column-INTERVIEW_PENDING_250'));
    await expect
      .poll(async () => (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationIds[0] } })).pipelineStatus, {
        timeout: 15_000,
      })
      .toBe('INTERVIEW_PENDING_250');
    // Now occupied, it opens up; the stage it left collapses.
    await expect(page.getByTestId('board-column-INTERVIEW_PENDING_250')).not.toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('board-column-APPLICATION_100')).toHaveAttribute('data-collapsed', 'true');

    // The toggle brings every empty stage back at full width.
    await page.getByTestId('board-show-empty').check();
    await expect(page.locator('[data-testid^="board-column-"][data-collapsed="true"]')).toHaveCount(0);
    await page.getByTestId('board-show-empty').uncheck();
    await expect(page.getByTestId('board-column-APPLICATION_100')).toHaveAttribute('data-collapsed', 'true');
  } finally {
    await prisma.statusChange.deleteMany({ where: { relationId: { in: relationIds } } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: relationIds } } });
    for (const e of emails) await cleanupByEmail(e);
    await cleanupByEmail(mentorEmail);
  }
});
