import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #618 UI: the card's "Manage owners & mentors" panel — add a mentor as OWNER
// from the picker, then remove; the last-owner guard error surfaces inline.
test('owners panel: add an owner from the picker; last-owner removal shows the error', async ({ browser }) => {
  const adminEmail = uniqueEmail('own-admin');
  const mentorEmail = uniqueEmail('own-mentor');
  const pw = 'OwnersPass123';
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Owners Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Owners Mentor');

  const project = await prisma.project.create({
    data: {
      name: 'Owners UI Project', ownerType: 'ADMIN', ownerUserId: admin.id, technologies: [],
      members: { create: { userId: admin.id, role: 'OWNER' } },
    },
  });

  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/projects');
    const card = page.locator('[data-testid="project-card"]', { hasText: 'Owners UI Project' });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByTestId('manage-owners').click();
    const panel = card.getByTestId('owners-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Owners Admin')).toBeVisible();

    // Add the mentor as a second OWNER from the picker.
    await panel.getByTestId('member-picker').selectOption(mentor.id);
    await panel.locator('select').nth(1).selectOption('OWNER');
    await panel.getByTestId('member-add').click();
    await expect(panel.getByText('Owners Mentor')).toBeVisible({ timeout: 10_000 });
    expect(await prisma.projectMember.count({ where: { projectId: project.id, role: 'OWNER' } })).toBe(2);

    // Remove the mentor again, then try to remove the last owner → inline error.
    await panel.locator('div', { hasText: 'Owners Mentor' }).last().getByRole('button').click();
    await expect(panel.getByText('Owners Mentor')).toHaveCount(0, { timeout: 10_000 });
    await panel.locator('div', { hasText: 'Owners Admin' }).last().getByRole('button').click();
    await expect(panel.getByText('at least one owner', { exact: false })).toBeVisible({ timeout: 10_000 });
  } finally {
    await ctx.close();
    await prisma.project.deleteMany({ where: { id: project.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
