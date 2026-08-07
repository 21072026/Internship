import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

// #933: the admin side of the mentor-application lifecycle (#904 API, #905
// public form) — list/detail, take-under-review, approve (new account or
// promote an existing one), reject, idempotency, and authz. Applications here
// are seeded directly via Prisma (like the GET test in mentor-applications.spec.ts)
// rather than through the public POST, so this file never touches that
// endpoint's shared per-IP rate-limit bucket.

async function seedApplication(overrides: Partial<{ fullName: string; email: string; expertise: string[]; capacity: number | null; status: 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' }> = {}) {
  return prisma.mentorApplication.create({
    data: {
      fullName: overrides.fullName ?? 'Seeded Mentor',
      email: overrides.email ?? uniqueEmail('mentor-app-review'),
      expertise: overrides.expertise ?? ['React', 'Mentoring'],
      experience: 'Five years building web apps.',
      motivation: 'I want to give back to the community.',
      capacity: overrides.capacity ?? 3,
      linkedinUrl: 'https://linkedin.com/in/seeded-mentor',
      consentAt: new Date(),
      status: overrides.status ?? 'PENDING',
    },
  });
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin list shows a pending application and the detail page renders every field', { tag: '@smoke' }, async ({ page }) => {
  const adminEmail = uniqueEmail('mentor-app-review-admin');
  const pw = 'ReviewAdmin123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Review Admin');
  const app = await seedApplication({ fullName: 'Detail View Mentor' });

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');
    await page.goto('/admin/mentor-applications');
    await expect(page.getByTestId(`mentor-application-${app.id}`)).toBeVisible();

    await page.getByTestId(`mentor-application-${app.id}`).getByRole('link', { name: 'Detail View Mentor' }).click();
    await page.waitForURL((u) => u.pathname === `/admin/mentor-applications/${app.id}`);

    await expect(page.getByText('React')).toBeVisible();
    await expect(page.getByText('Five years building web apps.')).toBeVisible();
    await expect(page.getByText('I want to give back to the community.')).toBeVisible();
    await expect(page.getByText('linkedin.com/in/seeded-mentor')).toBeVisible();
  } finally {
    await prisma.mentorApplication.deleteMany({ where: { id: app.id } });
    await cleanupByEmail(adminEmail);
  }
});

test('taking an application under review updates its status and sends the applicant an email', { tag: '@smoke' }, async ({ page }) => {
  const adminEmail = uniqueEmail('mentor-app-review-admin');
  const pw = 'ReviewAdmin123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Review Admin');
  const app = await seedApplication({ fullName: 'Under Review Mentor' });

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');
    await page.goto(`/admin/mentor-applications/${app.id}`);
    await page.getByRole('button', { name: 'Take under review' }).click();
    await expect(page.getByText('Marked as under review')).toBeVisible();

    await expect
      .poll(async () => (await prisma.mentorApplication.findUnique({ where: { id: app.id } }))?.status)
      .toBe('UNDER_REVIEW');
  } finally {
    await prisma.mentorApplication.deleteMany({ where: { id: app.id } });
    await cleanupByEmail(adminEmail);
  }
});

test('rejecting requires a reason and records it internally', { tag: '@smoke' }, async ({ page }) => {
  const adminEmail = uniqueEmail('mentor-app-review-admin');
  const pw = 'ReviewAdmin123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Review Admin');
  const app = await seedApplication({ fullName: 'Rejected Mentor' });

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');
    await page.goto(`/admin/mentor-applications/${app.id}`);

    const rejectButton = page.getByTestId('mentor-application-reject');
    await expect(rejectButton).toBeDisabled();
    await page.getByTestId('mentor-application-reject-reason').fill('Not enough professional experience yet.');
    await expect(rejectButton).toBeEnabled();
    await rejectButton.click();
    await expect(page.getByText('Application rejected')).toBeVisible();

    const updated = await prisma.mentorApplication.findUnique({ where: { id: app.id } });
    expect(updated?.status).toBe('REJECTED');
    expect(updated?.rejectReason).toBe('Not enough professional experience yet.');
  } finally {
    await prisma.mentorApplication.deleteMany({ where: { id: app.id } });
    await cleanupByEmail(adminEmail);
  }
});

test('approving a new applicant creates an invitation and a second approve attempt is a no-op (idempotent)', { tag: '@smoke' }, async ({ page }) => {
  const adminEmail = uniqueEmail('mentor-app-review-admin');
  const pw = 'ReviewAdmin123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Review Admin');
  const app = await seedApplication({ fullName: 'Approved New Mentor' });

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');
    await page.goto(`/admin/mentor-applications/${app.id}`);
    await page.getByTestId('mentor-application-approve').click();
    await expect(page.getByText('Application approved')).toBeVisible();
    await expect(page.getByText('An invitation email was sent')).toBeVisible();

    await expect
      .poll(async () => (await prisma.mentorApplication.findUnique({ where: { id: app.id } }))?.status)
      .toBe('APPROVED');
    expect(await prisma.user.findUnique({ where: { email: app.email } })).toBeNull();
    expect(await prisma.invitationToken.count({ where: { email: app.email } })).toBe(1);

    // Second decision on the same application (double click / retry) must not
    // create a second invitation or flip anything else.
    const second = await page.request.patch(`/api/mentor-applications/${app.id}`, {
      data: { action: 'approve' },
    });
    expect(second.status()).toBe(409);
    expect((await second.json()).code).toBe('already_decided');
    expect(await prisma.invitationToken.count({ where: { email: app.email } })).toBe(1);
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: app.email } });
    await prisma.mentorApplication.deleteMany({ where: { id: app.id } });
    await cleanupByEmail(adminEmail);
  }
});

test('approving an applicant who already has a mentee account promotes it to MENTOR instead of duplicating', { tag: '@smoke' }, async ({ page }) => {
  const adminEmail = uniqueEmail('mentor-app-review-admin');
  const pw = 'ReviewAdmin123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Review Admin');
  const menteeEmail = uniqueEmail('mentor-app-review-mentee');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Existing Mentee');
  const app = await seedApplication({ fullName: 'Existing Mentee', email: menteeEmail, capacity: 5 });

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');
    await page.goto(`/admin/mentor-applications/${app.id}`);
    await page.getByTestId('mentor-application-approve').click();
    await expect(page.getByText('Application approved')).toBeVisible();
    await expect(page.getByText('Their existing account now has mentor access')).toBeVisible();

    const promoted = await prisma.user.findUnique({ where: { id: mentee.id } });
    expect(promoted?.role).toBe('MENTOR');
    expect(promoted?.mentorCapacity).toBe(5);
    expect(await prisma.invitationToken.count({ where: { email: menteeEmail } })).toBe(0);
  } finally {
    await prisma.mentorApplication.deleteMany({ where: { id: app.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('the decide endpoint requires admin auth: 401 anonymous, 403 for a non-admin role', async ({ page, request }) => {
  const app = await seedApplication({ fullName: 'Authz Probe Mentor' });
  const menteeEmail = uniqueEmail('mentor-app-review-authz-mentee');
  const pw = 'AuthzPass123';
  await seedUser(menteeEmail, pw, 'MENTEE', 'Authz Mentee');

  try {
    const anonGet = await request.get(`/api/mentor-applications/${app.id}`);
    expect(anonGet.status()).toBe(401);
    const anonPatch = await request.patch(`/api/mentor-applications/${app.id}`, { data: { action: 'review' } });
    expect(anonPatch.status()).toBe(401);

    await signInAsFreshUser(page, menteeEmail, pw, '/portal');
    const menteeGet = await page.request.get(`/api/mentor-applications/${app.id}`);
    expect(menteeGet.status()).toBe(403);
    const menteePatch = await page.request.patch(`/api/mentor-applications/${app.id}`, { data: { action: 'review' } });
    expect(menteePatch.status()).toBe(403);

    expect((await prisma.mentorApplication.findUnique({ where: { id: app.id } }))?.status).toBe('PENDING');
  } finally {
    await prisma.mentorApplication.deleteMany({ where: { id: app.id } });
    await cleanupByEmail(menteeEmail);
  }
});

test('landing and sign-in pages link to the public mentor application form', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('become-mentor-link')).toBeVisible();
  await page.getByTestId('become-mentor-link').click();
  await page.waitForURL((u) => u.pathname === '/apply-as-mentor');
  await expect(page.getByRole('heading', { name: 'Apply to become a mentor' })).toBeVisible();

  await page.goto('/auth/signin');
  await expect(page.getByTestId('become-mentor-link')).toBeVisible();
});

test('the public apply form and its landing link stay usable on a phone-sized viewport', { tag: '@smoke' }, async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');
  const link = page.getByTestId('become-mentor-link');
  await expect(link).toBeVisible();
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeInViewport();

  await page.goto('/apply-as-mentor');
  const submit = page.getByRole('button', { name: 'Submit application' });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
});

// #906 (salvaged from the superseded PR #1076): the admin sidebar carries the
// pending-application count so the queue is visible from any admin page.
// The DB is shared across specs, so the exact number is not assertable —
// seeding one PENDING row only guarantees the badge is non-zero.
test('the admin nav shows a badge with the pending application count', async ({ page }) => {
  const adminEmail = uniqueEmail('mentor-app-badge-admin');
  const pw = 'BadgeAdmin123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Badge Admin');
  const app = await seedApplication({ fullName: 'Badge Count Mentor' });

  try {
    await signInAsFreshUser(page, adminEmail, pw, '/admin');
    const badge = page.getByTestId('mentor-applications-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/^(\d|9\+)$/);
  } finally {
    await prisma.mentorApplication.deleteMany({ where: { id: app.id } });
    await cleanupByEmail(adminEmail);
  }
});
