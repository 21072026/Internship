import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { acceptConfirmDialog, cancelConfirmDialog, confirmDialog } from './helpers/confirm';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #942: the two direct admin assignment flows — the inline picker on
// /admin/candidates (AssignMentorInline.tsx) and the assign form on
// /admin/mentorship — must ask for confirmation before assigning a mentor
// whose availability.status (from GET /api/users?view=mentorAvailability) is
// at_capacity or not_accepting. An available mentor skips the dialog
// entirely, and cancelling must never send the POST.

async function signInAsAdmin(page: import('@playwright/test').Page, email: string, pw: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
}

test('assigning an available mentor from the candidates picker skips the dialog and assigns directly', async ({ page }) => {
  const adminEmail = uniqueEmail('mac-avail-admin');
  const mentorEmail = uniqueEmail('mac-avail-mentor');
  const menteeEmail = uniqueEmail('mac-avail-mentee');
  const pw = 'AssignPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'MAC Avail Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'MAC Avail Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'MAC Avail Mentee');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 5, acceptingMentees: true } });

  try {
    await signInAsAdmin(page, adminEmail, pw);
    await page.goto('/admin/candidates');
    const card = page.getByTestId(`candidate-card-${mentee.id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    const postRequest = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/mentorship'), { timeout: 10_000 });
    await card.locator('select').selectOption(mentor.id);
    await card.getByRole('button', { name: 'Assign', exact: true }).click();
    await postRequest;
    await expect(confirmDialog(page)).toHaveCount(0);

    await expect(async () => {
      const relation = await prisma.mentorshipRelation.findFirst({ where: { mentorId: mentor.id, menteeId: mentee.id } });
      expect(relation).toBeTruthy();
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id, menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('assigning an at-capacity mentor from the candidates picker asks for confirmation; cancel sends no request, confirm assigns', async ({ page }) => {
  const adminEmail = uniqueEmail('mac-cap-admin');
  const mentorEmail = uniqueEmail('mac-cap-mentor');
  const existingMenteeEmail = uniqueEmail('mac-cap-existing-mentee');
  const newMenteeEmail = uniqueEmail('mac-cap-new-mentee');
  const pw = 'AssignPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'MAC Cap Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'MAC Cap Mentor');
  const existingMentee = await seedUser(existingMenteeEmail, pw, 'MENTEE', 'MAC Cap Existing Mentee');
  const newMentee = await seedUser(newMenteeEmail, pw, 'MENTEE', 'MAC Cap New Mentee');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 1 } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: existingMentee.id, orgId: existingMentee.orgId, status: 'ACTIVE', startDate: new Date() },
  });

  try {
    await signInAsAdmin(page, adminEmail, pw);
    await page.goto('/admin/candidates');
    const card = page.getByTestId(`candidate-card-${newMentee.id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('select').selectOption(mentor.id);

    // Cancel: the dialog opens but no POST leaves the page, and the relation
    // is never created.
    const noRequestYet = page
      .waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/mentorship'), { timeout: 2_000 })
      .catch(() => null);
    await card.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await expect(page.locator('#confirm-dialog-message')).toContainText('capacity');
    expect(await noRequestYet).toBeNull();
    await cancelConfirmDialog(page);
    const afterCancel = await prisma.mentorshipRelation.findFirst({ where: { mentorId: mentor.id, menteeId: newMentee.id } });
    expect(afterCancel).toBeNull();

    // Confirm: the same POST now runs and the relation is created.
    const postRequest = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/mentorship'), { timeout: 10_000 });
    await card.getByRole('button', { name: 'Assign', exact: true }).click();
    await acceptConfirmDialog(page);
    await postRequest;

    await expect(async () => {
      const relation = await prisma.mentorshipRelation.findFirst({ where: { mentorId: mentor.id, menteeId: newMentee.id } });
      expect(relation).toBeTruthy();
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(newMenteeEmail);
    await cleanupByEmail(existingMenteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('assigning a not-accepting mentor from the candidates picker asks for confirmation and assigns on confirm', async ({ page }) => {
  const adminEmail = uniqueEmail('mac-acc-admin');
  const mentorEmail = uniqueEmail('mac-acc-mentor');
  const menteeEmail = uniqueEmail('mac-acc-mentee');
  const pw = 'AssignPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'MAC Acc Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'MAC Acc Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'MAC Acc Mentee');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 10, acceptingMentees: false } });

  try {
    await signInAsAdmin(page, adminEmail, pw);
    await page.goto('/admin/candidates');
    const card = page.getByTestId(`candidate-card-${mentee.id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('select').selectOption(mentor.id);

    const postRequest = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/mentorship'), { timeout: 10_000 });
    await card.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await expect(page.locator('#confirm-dialog-message')).toContainText('not accepting');
    await acceptConfirmDialog(page);
    await postRequest;

    await expect(async () => {
      const relation = await prisma.mentorshipRelation.findFirst({ where: { mentorId: mentor.id, menteeId: mentee.id } });
      expect(relation).toBeTruthy();
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id, menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('the /admin/mentorship assign form asks for confirmation before assigning an at-capacity mentor', async ({ page }) => {
  const adminEmail = uniqueEmail('mac-form-admin');
  const mentorEmail = uniqueEmail('mac-form-mentor');
  const existingMenteeEmail = uniqueEmail('mac-form-existing-mentee');
  const newMenteeEmail = uniqueEmail('mac-form-new-mentee');
  const pw = 'AssignPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'MAC Form Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'MAC Form Mentor');
  const existingMentee = await seedUser(existingMenteeEmail, pw, 'MENTEE', 'MAC Form Existing Mentee');
  const newMentee = await seedUser(newMenteeEmail, pw, 'MENTEE', 'MAC Form New Mentee');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 1 } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: existingMentee.id, orgId: existingMentee.orgId, status: 'ACTIVE', startDate: new Date() },
  });

  try {
    await signInAsAdmin(page, adminEmail, pw);
    await page.goto('/admin/mentorship');
    await page.getByRole('button', { name: 'Assign mentorship' }).click();

    // Exact + the trailing "*" of the required-field label: an unqualified
    // getByLabel('Mentor') substring-matches the dialog's own accessible name
    // too ("Assign mentorship" contains "mentor"), which resolved to 2
    // elements (the dialog and the <select>) and made selectOption ambiguous.
    await page.getByLabel('Mentor*', { exact: true }).selectOption(mentor.id);
    await page.getByLabel('Mentee').selectOption(newMentee.id);

    // Cancel first: no request, mentorship modal stays open, relation not created.
    const noRequestYet = page
      .waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/mentorship'), { timeout: 2_000 })
      .catch(() => null);
    await page.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(confirmDialog(page)).toBeVisible();
    expect(await noRequestYet).toBeNull();
    await cancelConfirmDialog(page);
    const afterCancel = await prisma.mentorshipRelation.findFirst({ where: { mentorId: mentor.id, menteeId: newMentee.id } });
    expect(afterCancel).toBeNull();
    // The underlying assign form is still open and the selection survived.
    await expect(page.getByLabel('Mentor*', { exact: true })).toHaveValue(mentor.id);

    const postRequest = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/mentorship'), { timeout: 10_000 });
    await page.getByRole('button', { name: 'Assign', exact: true }).click();
    await acceptConfirmDialog(page);
    await postRequest;

    await expect(async () => {
      const relation = await prisma.mentorshipRelation.findFirst({ where: { mentorId: mentor.id, menteeId: newMentee.id } });
      expect(relation).toBeTruthy();
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(newMenteeEmail);
    await cleanupByEmail(existingMenteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
