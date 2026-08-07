import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { acceptConfirmDialog } from './helpers/confirm';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #785: the goals panel sorts newest→oldest / oldest→newest, supports inline
// editing of active goals, and a goal marked done leaves the active list for
// the collapsible archive (toggled via the "Archive" button), where it can be
// reopened or deleted. The active/completed counters track both lists.
// Archived items beyond ARCHIVE_PAGE_SIZE are paged behind a "Show all / Show
// less" toggle (covered in the second test below).
test('goals can be sorted, edited inline, archived, reopened and deleted', async ({ page }) => {
  const mentorEmail = uniqueEmail('goal-arch-mentor');
  const menteeEmail = uniqueEmail('goal-arch-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Goal Arch Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Goal Arch Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  try {
    // Two open goals with distinct creation times, so ordering is deterministic.
    const older = await prisma.goal.create({
      data: { relationId: rel.id, title: 'Older goal alpha', createdAt: new Date('2026-01-01T10:00:00Z') },
    });
    const newer = await prisma.goal.create({
      data: { relationId: rel.id, title: 'Newer goal beta', createdAt: new Date('2026-02-01T10:00:00Z') },
    });

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto(`/mentor/mentees/${rel.id}`);
    const activeList = page.getByTestId('active-goals');
    await expect(activeList).toBeVisible({ timeout: 10_000 });

    // Two counters (no percentage/progress bar) reflect the active/archived split.
    const activeCount = page.getByTestId('goals-active-count');
    const completedCount = page.getByTestId('goals-completed-count');
    await expect(activeCount).toContainText('2');
    await expect(completedCount).toContainText('0');

    // Default sort is newest first.
    await expect(activeList.locator('> div').first()).toContainText('Newer goal beta');

    // Oldest first flips the order — applies to both the active and archive lists.
    await page.getByLabel('Sort by').selectOption('oldest');
    await expect(activeList.locator('> div').first()).toContainText('Older goal alpha');

    // Inline editing: edit the older goal's title without deleting/re-adding it.
    const olderRow = page.getByTestId(`goal-${older.id}`);
    await olderRow.getByRole('button', { name: 'Edit' }).click();
    const titleInput = olderRow.getByLabel('Goal', { exact: true });
    await titleInput.fill('Older goal alpha (edited)');
    await olderRow.getByRole('button', { name: 'Save' }).click();
    await expect(olderRow).toContainText('Older goal alpha (edited)', { timeout: 10_000 });
    await expect(olderRow.getByRole('button', { name: 'Save' })).toHaveCount(0);

    const editedGoal = await prisma.goal.findUnique({ where: { id: older.id } });
    expect(editedGoal?.title).toBe('Older goal alpha (edited)');

    // The archive starts collapsed; opening it reveals an empty state until
    // something is marked done.
    const archiveToggle = page.getByRole('button', { name: 'Archive', exact: true });
    await expect(archiveToggle).toHaveAttribute('aria-expanded', 'false');
    await archiveToggle.click();
    await expect(archiveToggle).toHaveAttribute('aria-expanded', 'true');
    const archiveSection = page.getByTestId('goals-archive');
    await expect(archiveSection).toBeVisible();
    await expect(archiveSection).toContainText('No completed goals yet');

    // Marking a goal done removes it from the active list…
    const newerRow = page.getByTestId(`goal-${newer.id}`);
    await newerRow.getByRole('button', { name: 'Mark done' }).click();
    await expect(activeList.getByText('Newer goal beta')).toHaveCount(0, { timeout: 10_000 });
    await expect(activeList.getByText('Older goal alpha (edited)')).toBeVisible();

    // …and it shows up in the archive, with its completion state preserved.
    await expect(archiveSection.getByText('Newer goal beta')).toBeVisible({ timeout: 10_000 });
    const stored = await prisma.goal.findUnique({ where: { id: newer.id } });
    expect(stored?.status).toBe('DONE');
    expect(stored?.completedAt).not.toBeNull();
    await expect(activeCount).toContainText('1');
    await expect(completedCount).toContainText('1');

    // Reopen it from the archive — it moves back to the active list.
    await archiveSection.getByRole('button', { name: 'Reopen' }).click();
    await expect(activeList.getByText('Newer goal beta')).toBeVisible({ timeout: 10_000 });
    await expect(archiveSection.getByText('Newer goal beta')).toHaveCount(0);
    const reopened = await prisma.goal.findUnique({ where: { id: newer.id } });
    expect(reopened?.status).toBe('OPEN');
    await expect(activeCount).toContainText('2');
    await expect(completedCount).toContainText('0');

    // Delete it from the active list (the in-app confirm dialog is accepted).
    await page.getByTestId(`goal-${newer.id}`).getByRole('button', { name: 'Delete' }).click();
    await acceptConfirmDialog(page);
    await expect(page.getByTestId(`goal-${newer.id}`)).toHaveCount(0, { timeout: 10_000 });
    const deleted = await prisma.goal.findUnique({ where: { id: newer.id } });
    expect(deleted).toBeNull();
    await expect(activeCount).toContainText('1');
    await expect(completedCount).toContainText('0');
  } finally {
    await prisma.goal.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('goals archive pages past 10 items behind a Show all / Show less toggle', async ({ page }) => {
  const mentorEmail = uniqueEmail('goal-page-mentor');
  const menteeEmail = uniqueEmail('goal-page-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Goal Page Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Goal Page Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  try {
    // 11 already-completed goals — one more than ARCHIVE_PAGE_SIZE (10).
    for (let i = 0; i < 11; i++) {
      await prisma.goal.create({
        data: {
          relationId: rel.id,
          title: `Archived goal ${i}`,
          status: 'DONE',
          completedAt: new Date(`2026-03-0${(i % 9) + 1}T10:00:00Z`),
          createdAt: new Date(`2026-02-${10 + i}T10:00:00Z`),
        },
      });
    }

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto(`/mentor/mentees/${rel.id}`);

    // The completed-goals counter reflects the full count, not the paginated slice.
    await expect(page.getByTestId('goals-active-count')).toContainText('0');
    await expect(page.getByTestId('goals-completed-count')).toContainText('11');

    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    const archiveSection = page.getByTestId('goals-archive');
    await expect(archiveSection).toBeVisible();

    const archivedRows = archiveSection.locator('[data-testid^="goal-"]');
    await expect(archivedRows).toHaveCount(10, { timeout: 10_000 });

    const toggleButton = archiveSection.getByRole('button', { name: /Show all|Show less/ });
    await expect(toggleButton).toHaveText('Show all');
    await toggleButton.click();
    await expect(archivedRows).toHaveCount(11, { timeout: 10_000 });
    await expect(toggleButton).toHaveText('Show less');

    await toggleButton.click();
    await expect(archivedRows).toHaveCount(10, { timeout: 10_000 });
    await expect(toggleButton).toHaveText('Show all');
  } finally {
    await prisma.goal.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
