import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { acceptConfirmDialog, cancelConfirmDialog, confirmDialog } from './helpers/confirm';
import { pickPerson } from './helpers/personPicker';
import { gotoSettled, signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #942: the two direct admin assignment flows — the inline picker on
// /admin/candidates (AssignMentorInline.tsx) and the assign form on
// /admin/mentorship — must ask for confirmation before assigning a mentor
// whose availability.status (from GET /api/users?view=mentorAvailability) is
// at_capacity or not_accepting. An available mentor skips the dialog
// entirely, and cancelling must never send the POST.

// Each test runs in its own organization: the candidates list and the mentor
// picker then hold this test's people only, instead of every candidate the
// rest of the suite left in the shared database — a card on page two of a
// crowded list was a timeout, not a failure of the confirmation flow.
async function freshOrg(tag: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return prisma.organization.create({ data: { name: `MAC ${tag} ${stamp}`, slug: `mac-${tag}-${stamp}` } });
}

test('assigning an available mentor from the candidates picker skips the dialog and assigns directly', async ({ page }) => {
  const adminEmail = uniqueEmail('mac-avail-admin');
  const mentorEmail = uniqueEmail('mac-avail-mentor');
  const menteeEmail = uniqueEmail('mac-avail-mentee');
  const pw = 'AssignPass123';
  const org = await freshOrg('avail');
  await seedUser(adminEmail, pw, 'ADMIN', 'MAC Avail Admin', org.id);
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'MAC Avail Mentor', org.id);
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'MAC Avail Mentee', org.id);
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 5, acceptingMentees: true } });

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, '/admin/candidates');
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
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});

test('assigning an at-capacity mentor from the candidates picker asks for confirmation; cancel sends no request, confirm assigns', async ({ page }) => {
  const adminEmail = uniqueEmail('mac-cap-admin');
  const mentorEmail = uniqueEmail('mac-cap-mentor');
  const existingMenteeEmail = uniqueEmail('mac-cap-existing-mentee');
  const newMenteeEmail = uniqueEmail('mac-cap-new-mentee');
  const pw = 'AssignPass123';
  const org = await freshOrg('cap');
  await seedUser(adminEmail, pw, 'ADMIN', 'MAC Cap Admin', org.id);
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'MAC Cap Mentor', org.id);
  const existingMentee = await seedUser(existingMenteeEmail, pw, 'MENTEE', 'MAC Cap Existing Mentee', org.id);
  const newMentee = await seedUser(newMenteeEmail, pw, 'MENTEE', 'MAC Cap New Mentee', org.id);
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 1 } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: existingMentee.id, orgId: existingMentee.orgId, status: 'ACTIVE', startDate: new Date() },
  });

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, '/admin/candidates');
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
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});

test('assigning a not-accepting mentor from the candidates picker asks for confirmation and assigns on confirm', async ({ page }) => {
  const adminEmail = uniqueEmail('mac-acc-admin');
  const mentorEmail = uniqueEmail('mac-acc-mentor');
  const menteeEmail = uniqueEmail('mac-acc-mentee');
  const pw = 'AssignPass123';
  const org = await freshOrg('acc');
  await seedUser(adminEmail, pw, 'ADMIN', 'MAC Acc Admin', org.id);
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'MAC Acc Mentor', org.id);
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'MAC Acc Mentee', org.id);
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 10, acceptingMentees: false } });

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, '/admin/candidates');
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
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});

test('the /admin/mentorship assign form asks for confirmation before assigning an at-capacity mentor', async ({ page }) => {
  const adminEmail = uniqueEmail('mac-form-admin');
  const mentorEmail = uniqueEmail('mac-form-mentor');
  const existingMenteeEmail = uniqueEmail('mac-form-existing-mentee');
  const newMenteeEmail = uniqueEmail('mac-form-new-mentee');
  const pw = 'AssignPass123';
  const org = await freshOrg('form');
  await seedUser(adminEmail, pw, 'ADMIN', 'MAC Form Admin', org.id);
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'MAC Form Mentor', org.id);
  const existingMentee = await seedUser(existingMenteeEmail, pw, 'MENTEE', 'MAC Form Existing Mentee', org.id);
  const newMentee = await seedUser(newMenteeEmail, pw, 'MENTEE', 'MAC Form New Mentee', org.id);
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 1 } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: existingMentee.id, orgId: existingMentee.orgId, status: 'ACTIVE', startDate: new Date() },
  });

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, '/admin/mentorship');
    await page.getByRole('button', { name: 'Assign mentorship' }).click();

    // Exact + the trailing "*" of the required-field label: an unqualified
    // getByLabel('Mentor') substring-matches the dialog's own accessible name
    // too ("Assign mentorship" contains "mentor"), which resolved to 2
    // elements (the dialog and the <select>) and made selectOption ambiguous.
    await page.getByLabel('Mentor*', { exact: true }).selectOption(mentor.id);
    // The mentee field is a server-side search (#1437), not a <select>.
    await pickPerson(page, 'assign-mentee', newMentee);

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
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
