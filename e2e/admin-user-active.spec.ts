import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, submitSignInForm } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin deactivates a user and that user can no longer sign in', async ({ page }) => {
  const adminEmail = uniqueEmail('actadmin');
  const mentorEmail = uniqueEmail('actmentor');
  const mentorPw = 'MentorPass123!';
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Active Admin');
  const mentor = await seedUser(mentorEmail, mentorPw, 'MENTOR', 'Toggle Mentor');

  try {
    // Admin signs in and opens the Users page.
    await signInAsFreshUser(page, adminEmail, 'AdminPass123!', '/admin');

    await page.goto('/admin/users');
    // Deactivate the seeded mentor via its row.
    const row = page.getByTestId(`user-row-${mentor.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    const patched = page.waitForResponse(
      (r) => r.url().includes(`/api/users/${mentor.id}`) && r.request().method() === 'PATCH'
    );
    await row.getByRole('button', { name: 'Deactivate' }).click();
    await patched;

    const updated = await prisma.user.findUnique({ where: { id: mentor.id } });
    expect(updated!.isActive).toBe(false);
    // Switching off a verified account is not the same as parking a sign-up for
    // review: pendingApproval is what keeps those two apart on the sign-in page
    // (#1085), so an admin's "off" must not borrow it.
    expect(updated!.pendingApproval).toBe(false);

    // The deactivated mentor cannot sign in.
    // submitSignInForm, not signInAsFreshUser: a deactivated account is *supposed*
    // to stay on /auth/signin, so there is no landing page to wait for.
    await submitSignInForm(page, mentorEmail, mentorPw);
    await expect(page.getByText(/deactivated/i)).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).pathname).toContain('/auth/signin');
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
