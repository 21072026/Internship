import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a board card links to the record, whose stage select moves the relation without a drag', async ({ page }) => {
  const adminEmail = uniqueEmail('ba-admin');
  const mentorEmail = uniqueEmail('ba-mentor');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'BA Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'BA Mentor');
  const mentee = await seedUser(uniqueEmail('ba-mentee'), 'x', 'MENTEE', 'BA Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/board');
    await expect(page.getByText('BA Mentee')).toBeVisible({ timeout: 10_000 });

    // The board's only stage control is drag-and-drop; its single-pointer and
    // keyboard alternative is the record the card's name links to. Scope to this
    // test's own card: the admin board lists every relation in the database.
    const card = page.getByTestId('board-card').filter({ hasText: 'BA Mentee' });
    await expect(card.locator('select')).toHaveCount(0);
    const link = card.getByRole('link', { name: 'BA Mentee' });
    await link.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => u.pathname === `/admin/candidates/${mentee.id}`, { timeout: 15_000 });
    await page.getByTestId('stage-select').selectOption('INTERVIEW_PENDING_250');

    await expect.poll(async () => {
      const r = await prisma.mentorshipRelation.findUnique({ where: { id: rel.id } });
      return r?.pipelineStatus;
    }, { timeout: 10_000 }).toBe('INTERVIEW_PENDING_250');
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
