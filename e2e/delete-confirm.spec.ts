import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #470: unconfirmed delete actions must ask for confirmation first, and
// cancelling must not send the delete request at all.
test('deleting a personal note asks for confirmation; cancelling keeps the note', async ({ page }) => {
  const email = uniqueEmail('delconfirm-mentee');
  const mentee = await seedUser(email, 'MenteePass123', 'MENTEE', 'Del Confirm Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/portal/notes');
    await page.fill('textarea', 'Note that should survive a cancelled delete');
    await page.click('button[type="submit"]');
    await expect(page.getByText('Note that should survive a cancelled delete')).toBeVisible();

    let dialogMessage = '';
    page.once('dialog', async (d) => {
      dialogMessage = d.message();
      await d.dismiss();
    });
    const deleteRequest = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().includes('/api/notes/'), { timeout: 2_000 }).catch(() => null);
    await page.getByLabel('Delete').click();
    expect(await deleteRequest).toBeNull();
    expect(dialogMessage.length).toBeGreaterThan(0);
    await expect(page.getByText('Note that should survive a cancelled delete')).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await page.getByLabel('Delete').click();
    await expect(page.getByText('Note that should survive a cancelled delete')).toHaveCount(0);
  } finally {
    await prisma.personalNote.deleteMany({ where: { userId: mentee.id } });
    await cleanupByEmail(email);
  }
});
