import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { acceptConfirmDialog, cancelConfirmDialog, confirmDialog } from './helpers/confirm';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #942: /admin/invite's "connect to this mentor" picker (a MENTEE invite may
// pre-link a mentor — the mentorship is created the moment the invitee
// registers, see register/route.ts) must ask for confirmation before sending
// an invite that pre-links a mentor whose availability.status is
// at_capacity/not_accepting — same gate, same ConfirmDialog copy as the
// direct-assignment and request-approval flows. An available mentor skips
// the dialog, and cancelling must never send the POST.

async function signInAsAdmin(page: import('@playwright/test').Page, email: string, pw: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
}

test('inviting a mentee with an available mentor pre-linked skips the dialog and sends directly', async ({ page }) => {
  const adminEmail = uniqueEmail('imc-avail-admin');
  const mentorEmail = uniqueEmail('imc-avail-mentor');
  const inviteeEmail = uniqueEmail('imc-avail-invitee');
  const pw = 'InvitePass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'IMC Avail Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'IMC Avail Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 5, acceptingMentees: true } });

  try {
    await signInAsAdmin(page, adminEmail, pw);
    await page.goto('/admin/invite');

    await page.fill('input[type="email"]', inviteeEmail);
    await page.getByLabel('Connect to this mentor (optional)').selectOption(mentor.id);

    const postRequest = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/invite'), { timeout: 10_000 });
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    await postRequest;
    await expect(confirmDialog(page)).toHaveCount(0);

    await expect(async () => {
      const token = await prisma.invitationToken.findFirst({ where: { email: inviteeEmail } });
      expect(token).toBeTruthy();
      expect(token?.mentorId).toBe(mentor.id);
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: inviteeEmail } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('inviting a mentee with an at-capacity mentor pre-linked asks for confirmation; cancel sends no request, confirm sends the invite', async ({ page }) => {
  const adminEmail = uniqueEmail('imc-cap-admin');
  const mentorEmail = uniqueEmail('imc-cap-mentor');
  const existingMenteeEmail = uniqueEmail('imc-cap-existing-mentee');
  const inviteeEmail = uniqueEmail('imc-cap-invitee');
  const pw = 'InvitePass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'IMC Cap Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'IMC Cap Mentor');
  const existingMentee = await seedUser(existingMenteeEmail, pw, 'MENTEE', 'IMC Cap Existing Mentee');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 1 } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: existingMentee.id, orgId: existingMentee.orgId, status: 'ACTIVE', startDate: new Date() },
  });

  try {
    await signInAsAdmin(page, adminEmail, pw);
    await page.goto('/admin/invite');

    await page.fill('input[type="email"]', inviteeEmail);
    await page.getByLabel('Connect to this mentor (optional)').selectOption(mentor.id);

    // Cancel: the dialog opens but no POST leaves the page, and no invitation
    // token is created.
    const noRequestYet = page
      .waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/invite'), { timeout: 2_000 })
      .catch(() => null);
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await expect(page.locator('#confirm-dialog-message')).toContainText('capacity');
    expect(await noRequestYet).toBeNull();
    await cancelConfirmDialog(page);
    expect(await prisma.invitationToken.findFirst({ where: { email: inviteeEmail } })).toBeNull();
    // The form's selections survived the cancel.
    await expect(page.locator('input[type="email"]')).toHaveValue(inviteeEmail);
    await expect(page.getByLabel('Connect to this mentor (optional)')).toHaveValue(mentor.id);

    // Confirm: the same POST now runs and the invitation is created.
    const postRequest = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/invite'), { timeout: 10_000 });
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    await acceptConfirmDialog(page);
    await postRequest;

    await expect(async () => {
      const token = await prisma.invitationToken.findFirst({ where: { email: inviteeEmail } });
      expect(token).toBeTruthy();
      expect(token?.mentorId).toBe(mentor.id);
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: inviteeEmail } });
    await cleanupByEmail(existingMenteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('inviting a mentee with a not-accepting mentor pre-linked asks for confirmation and sends the invite on confirm', async ({ page }) => {
  const adminEmail = uniqueEmail('imc-acc-admin');
  const mentorEmail = uniqueEmail('imc-acc-mentor');
  const inviteeEmail = uniqueEmail('imc-acc-invitee');
  const pw = 'InvitePass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'IMC Acc Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'IMC Acc Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 10, acceptingMentees: false } });

  try {
    await signInAsAdmin(page, adminEmail, pw);
    await page.goto('/admin/invite');

    await page.fill('input[type="email"]', inviteeEmail);
    await page.getByLabel('Connect to this mentor (optional)').selectOption(mentor.id);

    const postRequest = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/invite'), { timeout: 10_000 });
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await expect(page.locator('#confirm-dialog-message')).toContainText('not accepting');
    await acceptConfirmDialog(page);
    await postRequest;

    await expect(async () => {
      const token = await prisma.invitationToken.findFirst({ where: { email: inviteeEmail } });
      expect(token).toBeTruthy();
      expect(token?.mentorId).toBe(mentor.id);
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: inviteeEmail } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
