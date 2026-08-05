import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

// #906: the admin decision on a #904 mentor application — approve (creates a
// 7-day MENTOR InvitationToken, no account yet) or reject (reason required).
// Applications are seeded directly via Prisma (not through the public POST
// endpoint) so this file is independent of that endpoint's shared per-IP rate
// limit bucket (see mentor-applications.spec.ts's ordering note).

async function seedApplication(email: string, overrides: Partial<{ fullName: string; expertise: string[] }> = {}) {
  return prisma.mentorApplication.create({
    data: {
      fullName: overrides.fullName ?? 'Applicant Name',
      email,
      expertise: overrides.expertise ?? ['React'],
      motivation: 'I want to help junior developers grow.',
      consentAt: new Date(),
    },
  });
}

async function cleanupApplication(email: string) {
  await prisma.mentorApplication.deleteMany({ where: { email } });
  await prisma.invitationToken.deleteMany({ where: { email } });
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('PATCH is admin-only: unauthenticated 401, non-admin 403', async ({ page }) => {
  const email = uniqueEmail('mentor-decide-auth');
  const application = await seedApplication(email);
  const menteeEmail = uniqueEmail('mentor-decide-mentee');
  const pw = 'MenteePass123';
  await seedUser(menteeEmail, pw, 'MENTEE', 'Some Mentee');

  try {
    const unauth = await page.request.patch(`/api/mentor-applications/${application.id}`, {
      data: { action: 'approve' },
    });
    expect(unauth.status()).toBe(401);

    await signInAsFreshUser(page, menteeEmail, pw, '/portal');
    const forbidden = await page.request.patch(`/api/mentor-applications/${application.id}`, {
      data: { action: 'approve' },
    });
    expect(forbidden.status()).toBe(403);

    expect((await prisma.mentorApplication.findUnique({ where: { id: application.id } }))?.status).toBe('PENDING');
  } finally {
    await cleanupApplication(email);
    await cleanupByEmail(menteeEmail);
  }
});

test('approve creates a 7-day MENTOR invitation, decides the application, logs activity — and registering through it creates the MENTOR account', async ({ page }) => {
  const email = uniqueEmail('mentor-decide-approve');
  const adminEmail = uniqueEmail('mentor-decide-approve-admin');
  const pw = 'AdminPass123';
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Deciding Admin');
  const application = await seedApplication(email, { fullName: 'Approve Me' });

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');

    const before = Date.now();
    const res = await page.request.patch(`/api/mentor-applications/${application.id}`, {
      data: { action: 'approve' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.invitationId).toBeTruthy();

    const decided = await prisma.mentorApplication.findUnique({ where: { id: application.id } });
    expect(decided?.status).toBe('APPROVED');
    expect(decided?.decidedById).toBe(admin.id);
    expect(decided?.decidedAt).not.toBeNull();

    const invitation = await prisma.invitationToken.findUnique({ where: { id: body.invitationId } });
    expect(invitation).toBeTruthy();
    expect(invitation?.email).toBe(email);
    expect(invitation?.role).toBe('MENTOR');
    expect(invitation?.used).toBe(false);
    expect(invitation?.invitedById).toBe(admin.id);
    // ~7 days out, generous tolerance for test runtime.
    const daysOut = ((invitation!.expiresAt.getTime() - before) / (24 * 60 * 60 * 1000));
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);

    const activity = await prisma.activityLog.findFirst({
      where: { action: 'mentor_application.decided', targetType: 'mentor_application', targetId: application.id },
    });
    expect(activity).toBeTruthy();
    expect(activity?.actorId).toBe(admin.id);
    expect(activity?.detail).toContain('approved');

    // No account is created by approval itself — only registering through the
    // invitation link does.
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();

    // Complete the flow: register through the invitation → MENTOR account.
    const reg = await page.request.post('/api/register', {
      data: { token: invitation!.token, email, password: 'Passw0rd!23', fullName: 'Approve Me', consent: true },
    });
    expect(reg.status()).toBe(201);

    const mentor = await prisma.user.findUnique({ where: { email } });
    expect(mentor?.role).toBe('MENTOR');
    expect(mentor?.isActive).toBe(true);

    const usedInvitation = await prisma.invitationToken.findUnique({ where: { id: invitation!.id } });
    expect(usedInvitation?.used).toBe(true);
    expect(usedInvitation?.registeredAt).not.toBeNull();
  } finally {
    await cleanupApplication(email);
    await cleanupByEmail(adminEmail);
  }
});

test('reject requires a reason, stores it, and decides the application', async ({ page }) => {
  const email = uniqueEmail('mentor-decide-reject');
  const adminEmail = uniqueEmail('mentor-decide-reject-admin');
  const pw = 'AdminPass123';
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Rejecting Admin');
  const application = await seedApplication(email);

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');

    const noReason = await page.request.patch(`/api/mentor-applications/${application.id}`, {
      data: { action: 'reject' },
    });
    expect(noReason.status()).toBe(400);
    expect((await prisma.mentorApplication.findUnique({ where: { id: application.id } }))?.status).toBe('PENDING');

    const res = await page.request.patch(`/api/mentor-applications/${application.id}`, {
      data: { action: 'reject', rejectReason: 'Not enough mentoring experience yet.' },
    });
    expect(res.status()).toBe(200);

    const decided = await prisma.mentorApplication.findUnique({ where: { id: application.id } });
    expect(decided?.status).toBe('REJECTED');
    expect(decided?.rejectReason).toBe('Not enough mentoring experience yet.');
    expect(decided?.decidedById).toBe(admin.id);

    expect(await prisma.invitationToken.count({ where: { email } })).toBe(0);

    const activity = await prisma.activityLog.findFirst({
      where: { action: 'mentor_application.decided', targetType: 'mentor_application', targetId: application.id },
    });
    expect(activity?.detail).toContain('rejected');
  } finally {
    await cleanupApplication(email);
    await cleanupByEmail(adminEmail);
  }
});

test('a decided application 409s on a second decision (approve then reject, and a repeat approve)', async ({ page }) => {
  const email = uniqueEmail('mentor-decide-conflict');
  const adminEmail = uniqueEmail('mentor-decide-conflict-admin');
  const pw = 'AdminPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Conflict Admin');
  const application = await seedApplication(email);

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');

    const first = await page.request.patch(`/api/mentor-applications/${application.id}`, {
      data: { action: 'approve' },
    });
    expect(first.status()).toBe(200);

    const second = await page.request.patch(`/api/mentor-applications/${application.id}`, {
      data: { action: 'reject', rejectReason: 'Too late.' },
    });
    expect(second.status()).toBe(409);
    expect((await second.json()).code).toBe('already_decided');

    // Still APPROVED — the losing request must not have overwritten anything.
    expect((await prisma.mentorApplication.findUnique({ where: { id: application.id } }))?.status).toBe('APPROVED');

    const third = await page.request.patch(`/api/mentor-applications/${application.id}`, {
      data: { action: 'approve' },
    });
    expect(third.status()).toBe(409);

    // Only one invitation was ever created, from the winning request.
    expect(await prisma.invitationToken.count({ where: { email } })).toBe(1);
  } finally {
    await cleanupApplication(email);
    await cleanupByEmail(adminEmail);
  }
});

test('PATCH on an unknown id returns 404', async ({ page }) => {
  const adminEmail = uniqueEmail('mentor-decide-404-admin');
  const pw = 'AdminPass123';
  await seedUser(adminEmail, pw, 'ADMIN', '404 Admin');

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');
    const res = await page.request.patch('/api/mentor-applications/does-not-exist', {
      data: { action: 'approve' },
    });
    expect(res.status()).toBe(404);
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('admin UI: approve and reject from the pending/decided tabs, and the nav badge reflects the pending count', async ({ page }) => {
  const approveEmail = uniqueEmail('mentor-ui-approve');
  const rejectEmail = uniqueEmail('mentor-ui-reject');
  const adminEmail = uniqueEmail('mentor-ui-admin');
  const pw = 'AdminPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'UI Admin');
  const toApprove = await seedApplication(approveEmail, { fullName: 'UI Approve Candidate' });
  const toReject = await seedApplication(rejectEmail, { fullName: 'UI Reject Candidate' });

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');

    // The badge reflects the global pending count, which other tests/fixtures
    // in the shared dev DB may also contribute to — assert it renders a
    // non-empty count (a number, or the "9+" overflow label) rather than an
    // exact value.
    const badge = page.getByTestId('mentor-applications-badge');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    const badgeText = (await badge.textContent())?.trim() ?? '';
    expect(badgeText === '9+' || Number(badgeText) >= 2).toBe(true);

    await page.goto('/admin/mentor-applications');
    await page.waitForLoadState('networkidle');

    // Approve.
    const approveCard = page.getByTestId(`mentor-application-${toApprove.id}`);
    await expect(approveCard).toBeVisible();
    await approveCard.getByText('UI Approve Candidate').click();
    await approveCard.getByTestId('approve-application').click();
    await expect(page.getByTestId('mentor-app-notice')).toBeVisible();
    await expect(page.getByTestId(`mentor-application-${toApprove.id}`)).toHaveCount(0);

    // Reject, with the reason required before it will submit.
    const rejectCard = page.getByTestId(`mentor-application-${toReject.id}`);
    await expect(rejectCard).toBeVisible();
    await rejectCard.getByText('UI Reject Candidate').click();
    await rejectCard.getByTestId('reject-application').click();
    await rejectCard.getByTestId('confirm-reject').click();
    await expect(page.getByTestId('mentor-app-error')).toBeVisible();
    await rejectCard.getByTestId('reject-reason-input').fill('Not a fit right now.');
    await rejectCard.getByTestId('confirm-reject').click();
    await expect(page.getByTestId('mentor-app-notice')).toBeVisible();
    await expect(page.getByTestId(`mentor-application-${toReject.id}`)).toHaveCount(0);

    // Both now show up under "Decided".
    await page.getByTestId('tab-decided').click();
    await expect(page.getByTestId(`mentor-application-${toApprove.id}`)).toBeVisible();
    await expect(page.getByTestId(`mentor-application-${toReject.id}`)).toBeVisible();

    const approved = await prisma.mentorApplication.findUnique({ where: { id: toApprove.id } });
    const rejected = await prisma.mentorApplication.findUnique({ where: { id: toReject.id } });
    expect(approved?.status).toBe('APPROVED');
    expect(rejected?.status).toBe('REJECTED');
    expect(rejected?.rejectReason).toBe('Not a fit right now.');
  } finally {
    await cleanupApplication(approveEmail);
    await cleanupApplication(rejectEmail);
    await cleanupByEmail(adminEmail);
  }
});
