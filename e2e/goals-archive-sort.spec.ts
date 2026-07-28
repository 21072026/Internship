import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #785: the goals panel sorts newest→oldest / oldest→newest, and a goal marked
// done leaves the active list for the Archive tab (derived from `status`).
test('goals can be sorted and completed goals move to the archive tab', async ({ page }) => {
  const mentorEmail = uniqueEmail('goal-arch-mentor');
  const menteeEmail = uniqueEmail('goal-arch-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Goal Arch Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Goal Arch Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  try {
    // Two open goals with distinct creation times, so ordering is deterministic.
    await prisma.goal.create({
      data: { relationId: rel.id, title: 'Older goal alpha', createdAt: new Date('2026-01-01T10:00:00Z') },
    });
    await prisma.goal.create({
      data: { relationId: rel.id, title: 'Newer goal beta', createdAt: new Date('2026-02-01T10:00:00Z') },
    });

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto(`/mentor/mentees/${rel.id}`);
    const activeList = page.getByTestId('goals-list-active');
    await expect(activeList).toBeVisible({ timeout: 10_000 });

    // Default sort is newest first.
    await expect(activeList.locator('> div').first()).toContainText('Newer goal beta');

    // Oldest first flips the order.
    await page.getByTestId('goals-sort').selectOption('oldest');
    await expect(activeList.locator('> div').first()).toContainText('Older goal alpha');

    // Marking a goal done removes it from the active list…
    await activeList.locator('> div').first().getByRole('button', { name: /Mark done/i }).click();
    await expect(activeList.getByText('Older goal alpha')).toHaveCount(0, { timeout: 10_000 });
    await expect(activeList.getByText('Newer goal beta')).toBeVisible();

    // …and it shows up under Archive, with its completion state preserved.
    await page.getByTestId('goals-tab-archived').click();
    const archivedList = page.getByTestId('goals-list-archived');
    await expect(archivedList.getByText('Older goal alpha')).toBeVisible({ timeout: 10_000 });
    await expect(archivedList.getByText('Newer goal beta')).toHaveCount(0);
    await expect(archivedList.getByRole('button', { name: /Reopen/i })).toBeVisible();

    const stored = await prisma.goal.findFirst({ where: { relationId: rel.id, title: 'Older goal alpha' } });
    expect(stored?.status).toBe('DONE');
    expect(stored?.completedAt).not.toBeNull();
  } finally {
    await prisma.goal.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
