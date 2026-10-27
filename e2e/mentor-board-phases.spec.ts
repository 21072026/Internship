import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #2076: the mentor board groups its stages into the admin board's collapsible
// phases (the shared BoardPhaseGroups), and a column over the org's WIP limit
// shows the same amber "count / limit" chip — advisory, a move is never blocked.

const PASSWORD = 'BoardPhases123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.use({ viewport: { width: 1280, height: 900 } });

test('the mentor board groups stages into collapsible phases and shows the WIP warning', async ({ page }) => {
  const mentorEmail = uniqueEmail('board-phases-mentor');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Board Phases Mentor');
  // Nine in one stage: one over the shipped default limit of 8 (src/lib/boardWip.ts).
  const seeded = [
    ...Array.from({ length: 9 }, (_, i) => ({ name: `Phase Applicant ${i + 1}`, stage: 'APPLICATION_100' })),
    { name: 'Phase Intern', stage: 'INTERNSHIP_IN_PROGRESS_450' },
  ];
  const emails: string[] = [];
  const relationIds: string[] = [];
  for (const s of seeded) {
    const email = uniqueEmail('board-phases-mentee');
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

    // The admin board's phase headers, each with its own card total.
    const pre = page.getByTestId('board-group-pre');
    const internship = page.getByTestId('board-group-internship');
    await expect(pre).toHaveAttribute('aria-expanded', 'true');
    await expect(pre).toContainText('9');
    await expect(internship).toContainText('1');

    // Over the limit: amber count with the limit, a warning for screen readers.
    await expect(page.getByTestId('board-column-count-APPLICATION_100')).toContainText('9 / 8');
    await expect(page.getByTestId('board-column-count-INTERNSHIP_IN_PROGRESS_450')).toHaveText('1');

    // Collapsing a phase hides its cards and leaves the other phase alone.
    await pre.click();
    await expect(pre).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('board-card').filter({ hasText: 'Phase Applicant 1' })).toHaveCount(0);
    await expect(page.getByTestId('board-card').filter({ hasText: 'Phase Intern' })).toBeVisible();

    // ...and expanding brings them back.
    await pre.click();
    await expect(page.getByTestId('board-card').filter({ hasText: 'Phase Applicant 1' })).toBeVisible();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: relationIds } } });
    for (const e of emails) await cleanupByEmail(e);
    await cleanupByEmail(mentorEmail);
  }
});
