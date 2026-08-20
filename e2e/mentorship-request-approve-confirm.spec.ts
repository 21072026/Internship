import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';
import { acceptConfirmDialog, cancelConfirmDialog, confirmDialog } from './helpers/confirm';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #942: the admin request queue (MentorshipRequestQueue, rendered on
// /admin/mentorship) must ask for confirmation before approving a request
// with a mentor whose availability.status is at_capacity/not_accepting —
// same gate, same ConfirmDialog copy as the direct-assignment flows
// (mentor-assign-confirm.spec.ts). An available mentor skips the dialog, and
// cancelling must never send the PUT.

async function seedPendingRequest(page: import('@playwright/test').Page, menteeEmail: string, pw: string, fullName: string) {
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', fullName);
  await prisma.user.update({ where: { id: mentee.id }, data: { university: 'Test University', skills: ['React'] } });
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', menteeEmail);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
  const created = await page.request.post('/api/mentorship-requests', { data: {} });
  expect(created.status()).toBe(201);
  const requestId = (await created.json()).request.id as string;
  return { mentee, requestId };
}

test('approving a request with an available mentor skips the dialog and approves directly', async ({ page }) => {
  const adminEmail = uniqueEmail('rac-avail-admin');
  const mentorEmail = uniqueEmail('rac-avail-mentor');
  const menteeEmail = uniqueEmail('rac-avail-mentee');
  const pw = 'RequestPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'RAC Avail Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'RAC Avail Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 5, acceptingMentees: true } });

  const { mentee, requestId } = await seedPendingRequest(page, menteeEmail, pw, 'RAC Avail Mentee');

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');
    await page.goto('/admin/mentorship');

    const row = page.getByTestId(`request-${requestId}`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const putRequest = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/api/admin/mentorship-requests'), { timeout: 10_000 });
    await row.locator('select').selectOption(mentor.id);
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    await putRequest;
    await expect(confirmDialog(page)).toHaveCount(0);

    await expect(async () => {
      const relation = await prisma.mentorshipRelation.findFirst({ where: { menteeId: mentee.id, mentorId: mentor.id, status: 'ACTIVE' } });
      expect(relation).toBeTruthy();
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRequest.deleteMany({ where: { id: requestId } });
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id, menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('approving a request with an at-capacity mentor asks for confirmation; cancel sends no request, confirm approves', async ({ page }) => {
  const adminEmail = uniqueEmail('rac-cap-admin');
  const mentorEmail = uniqueEmail('rac-cap-mentor');
  const menteeEmail = uniqueEmail('rac-cap-mentee');
  const existingMenteeEmail = uniqueEmail('rac-cap-existing-mentee');
  const pw = 'RequestPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'RAC Cap Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'RAC Cap Mentor');
  const existingMentee = await seedUser(existingMenteeEmail, pw, 'MENTEE', 'RAC Cap Existing Mentee');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 1 } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: existingMentee.id, orgId: existingMentee.orgId, status: 'ACTIVE', startDate: new Date() },
  });

  const { mentee, requestId } = await seedPendingRequest(page, menteeEmail, pw, 'RAC Cap Mentee');

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');
    await page.goto('/admin/mentorship');

    const row = page.getByTestId(`request-${requestId}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('select').selectOption(mentor.id);

    // Cancel: the dialog opens but no PUT leaves the page, and the relation is
    // never created.
    const noRequestYet = page
      .waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/api/admin/mentorship-requests'), { timeout: 2_000 })
      .catch(() => null);
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await expect(page.locator('#confirm-dialog-message')).toContainText('capacity');
    expect(await noRequestYet).toBeNull();
    await cancelConfirmDialog(page);
    const afterCancel = await prisma.mentorshipRequest.findUnique({ where: { id: requestId } });
    expect(afterCancel?.status).toBe('PENDING');
    expect(await prisma.mentorshipRelation.findFirst({ where: { menteeId: mentee.id } })).toBeNull();

    // Confirm: the same PUT now runs and the relation is created.
    const putRequest = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/api/admin/mentorship-requests'), { timeout: 10_000 });
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    await acceptConfirmDialog(page);
    await putRequest;

    await expect(async () => {
      const relation = await prisma.mentorshipRelation.findFirst({ where: { menteeId: mentee.id, mentorId: mentor.id, status: 'ACTIVE' } });
      expect(relation).toBeTruthy();
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRequest.deleteMany({ where: { id: requestId } });
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(existingMenteeEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('approving a request with a not-accepting mentor asks for confirmation and approves on confirm', async ({ page }) => {
  const adminEmail = uniqueEmail('rac-acc-admin');
  const mentorEmail = uniqueEmail('rac-acc-mentor');
  const menteeEmail = uniqueEmail('rac-acc-mentee');
  const pw = 'RequestPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'RAC Acc Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'RAC Acc Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 10, acceptingMentees: false } });

  const { mentee, requestId } = await seedPendingRequest(page, menteeEmail, pw, 'RAC Acc Mentee');

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');
    await page.goto('/admin/mentorship');

    const row = page.getByTestId(`request-${requestId}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('select').selectOption(mentor.id);

    const putRequest = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/api/admin/mentorship-requests'), { timeout: 10_000 });
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await expect(page.locator('#confirm-dialog-message')).toContainText('not accepting');
    await acceptConfirmDialog(page);
    await putRequest;

    await expect(async () => {
      const relation = await prisma.mentorshipRelation.findFirst({ where: { menteeId: mentee.id, mentorId: mentor.id, status: 'ACTIVE' } });
      expect(relation).toBeTruthy();
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRequest.deleteMany({ where: { id: requestId } });
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id, menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
