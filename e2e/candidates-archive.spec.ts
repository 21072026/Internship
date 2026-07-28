import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Deactivated ("Devre dışı") candidates are hidden from the default Adaylar list
// and live in a separate Archive view.
test('deactivated candidates are archived and hidden from the default list', async ({ page }) => {
  const adminEmail = uniqueEmail('arch-admin');
  const activeEmail = uniqueEmail('arch-active');
  const archivedEmail = uniqueEmail('arch-inactive');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Arch Admin');
  const activeMentee = await seedUser(activeEmail, 'x', 'MENTEE', 'Zeynep ActiveOne');
  const archivedMentee = await seedUser(archivedEmail, 'x', 'MENTEE', 'Kerem ArchivedOne');
  // Deactivate one candidate directly.
  await prisma.user.update({ where: { id: archivedMentee.id }, data: { isActive: false } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Default (Active) view: the active candidate shows, the deactivated one does not.
    await page.goto('/admin/candidates');
    await expect(page.getByTestId(`candidate-card-${activeMentee.id}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`candidate-card-${archivedMentee.id}`)).toHaveCount(0);

    // Archive view: the deactivated candidate shows (with its Inactive badge), the active one does not.
    await page.getByTestId('candidates-tab-archived').click();
    await expect(page.getByTestId(`candidate-card-${archivedMentee.id}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`candidate-card-${archivedMentee.id}`).getByText('Inactive')).toBeVisible();
    await expect(page.getByTestId(`candidate-card-${activeMentee.id}`)).toHaveCount(0);

    // Back to Active.
    await page.getByTestId('candidates-tab-active').click();
    await expect(page.getByTestId(`candidate-card-${activeMentee.id}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`candidate-card-${archivedMentee.id}`)).toHaveCount(0);
  } finally {
    await cleanupByEmail(activeEmail);
    await cleanupByEmail(archivedEmail);
    await cleanupByEmail(adminEmail);
  }
});
