import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { acceptConfirmDialog, cancelConfirmDialog, confirmDialog } from './helpers/confirm';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #470: unconfirmed delete actions must ask for confirmation first, and
// cancelling must not send the delete request at all. Since #1071 the question
// is asked by the in-app ConfirmDialog rather than the browser's confirm(), so
// the assertions read the dialog out of the DOM instead of listening for a
// native `dialog` event.
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

    // Clicking Delete only asks the question — the dialog carries a message and
    // no request has left the page yet.
    const deleteRequest = page
      .waitForRequest((r) => r.method() === 'DELETE' && r.url().includes('/api/notes/'), { timeout: 2_000 })
      .catch(() => null);
    await page.getByLabel('Delete').click();
    await expect(confirmDialog(page)).toBeVisible();
    expect(((await page.locator('#confirm-dialog-message').textContent()) ?? '').trim().length).toBeGreaterThan(0);
    expect(await deleteRequest).toBeNull();

    // Cancelling keeps the note.
    await cancelConfirmDialog(page);
    await expect(page.getByText('Note that should survive a cancelled delete')).toBeVisible();

    // Confirming deletes it.
    await page.getByLabel('Delete').click();
    await acceptConfirmDialog(page);
    await expect(page.getByText('Note that should survive a cancelled delete')).toHaveCount(0);
  } finally {
    await prisma.personalNote.deleteMany({ where: { userId: mentee.id } });
    await cleanupByEmail(email);
  }
});
