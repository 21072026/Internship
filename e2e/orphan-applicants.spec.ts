import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * Orphan applicant accounts (#1780).
 *
 * The public apply link mints a real account before any human has said yes.
 * When the mentor declines, that account can never sign in, belongs to nobody
 * and has no `consentAt` for the consent-based retention review to anchor on —
 * so before this it simply stayed forever, counting as a candidate.
 *
 * The whole path in one test, because the safety property is the path: apply →
 * decline → the account is RECOGNISED (badge + filter on /admin/candidates),
 * LISTED with a count on /admin/retention (the dry run of the nightly sweep),
 * and can be ERASED through the existing double-gated erase flow, after which
 * it is gone from the candidate list.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a declined public applicant is recognised, listed and can be erased', async ({ page }) => {
  const adminEmail = uniqueEmail('orphan-admin');
  const mentorEmail = uniqueEmail('orphan-mentor');
  const applicantEmail = uniqueEmail('orphan-applicant');
  const applicantName = `ZZ Orphan Applicant ${Date.now()}`;
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Orphan Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Orphan Mentor');
  let applicantId: string | null = null;

  try {
    // 1. The public application — no session, exactly as a stranger sends it.
    const applied = await page.request.post('/api/apply', {
      data: { mentorId: mentor.id, fullName: applicantName, email: applicantEmail },
    });
    expect(applied.status()).toBe(200);

    const applicant = await prisma.user.findUnique({ where: { email: applicantEmail } });
    expect(applicant).not.toBeNull();
    applicantId = applicant!.id;
    // The sentinel #1780 fixed: an apply-link account has never had a password,
    // and the constant now lives in one place.
    expect(applicant!.password).toBe('!apply-no-login');

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // While the application is still PENDING nothing about it is orphaned —
    // a decision in progress must never be swept.
    await page.goto('/admin/retention');
    await expect(page.getByTestId('orphan-applicants')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`orphan-row-${applicantId}`)).toHaveCount(0);

    // 2. The mentor's answer is no.
    const request = await prisma.mentorshipRequest.findFirst({ where: { menteeId: applicantId } });
    expect(request).not.toBeNull();
    const declined = await page.request.put('/api/admin/mentorship-requests', {
      data: { requestId: request!.id, action: 'reject' },
    });
    expect(declined.ok()).toBeTruthy();

    // 3. Listed, with the count and who declined it.
    await page.goto('/admin/retention');
    const row = page.getByTestId(`orphan-row-${applicantId}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('orphan-applicants-count')).toBeVisible();
    await expect(row).toContainText('Orphan Mentor');
    // 90-day grace by default, so nothing is due today — the row says so
    // instead of being silently on tonight's list.
    await expect(row).not.toContainText('Next run');

    // 4. Recognised on the candidate list too. Scoped to the desktop grid:
    // /admin/candidates renders every candidate twice.
    await page.goto('/admin/candidates');
    const desktop = page.getByTestId('candidates-desktop-list');
    await expect(desktop.getByTestId(`candidate-card-${applicantId}`)).toBeVisible({ timeout: 15_000 });
    await expect(desktop.getByTestId(`candidate-orphan-${applicantId}`)).toBeVisible();

    // …and the filter narrows the list to exactly these accounts.
    await page.getByTestId('candidates-orphan-filter').click();
    await expect(desktop.getByTestId(`candidate-card-${applicantId}`)).toBeVisible({ timeout: 15_000 });
    await expect(desktop.getByTestId(`candidate-orphan-${applicantId}`)).toBeVisible();

    // 5. Erased through the existing gates — nothing new deletes accounts.
    await page.goto('/admin/retention');
    // Scoped to this row throughout: another spec's declined applicant may be
    // sitting in the same table, and the erase form is rendered per row.
    const eraseRow = page.getByTestId(`orphan-row-${applicantId}`);
    await expect(eraseRow.getByTestId(`orphan-erase-${applicantId}`)).toBeVisible({ timeout: 15_000 });
    await eraseRow.getByTestId(`orphan-erase-${applicantId}`).click();
    await eraseRow.getByRole('button', { name: /^Delete permanently$/i }).click();
    await eraseRow.getByTestId('erasure-confirm-name').fill(applicantName);
    await eraseRow.getByTestId('erasure-admin-password').fill('AdminPass123!');
    await eraseRow.getByRole('button', { name: /^Yes, delete permanently$/i }).click();

    await expect
      .poll(async () => prisma.user.findUnique({ where: { id: applicantId! } }), { timeout: 20_000 })
      .toBeNull();

    // Gone from the candidate list as well as from the table.
    await page.goto('/admin/candidates');
    await expect(page.getByTestId('candidates-desktop-list').getByText(applicantName, { exact: true })).toHaveCount(0);
  } finally {
    if (applicantId) {
      await prisma.activityLog.deleteMany({ where: { targetId: applicantId } });
      await prisma.mentorshipRequest.deleteMany({ where: { menteeId: applicantId } });
    }
    await cleanupByEmail(applicantEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
