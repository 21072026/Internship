import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';
import { freshIp, floodIp } from './helpers/rateLimit';

// #904: a public, unauthenticated application to become a mentor. No User is
// created on submission; an admin reviews the queue via GET (this task ships
// only POST + GET — approve/reject is a later task).
//
// The POST handler is IP-rate-limited (5 / 15 min) and the counter store is
// per PROCESS, so the whole shard used to share one `mentor-application:unknown`
// counter: these five POSTs alone reached the ceiling, and whichever spec ran
// next got the 429 (#2158). Each functional test now spends a synthetic address
// of its own; the flood test at the bottom pins one on purpose, because it is
// measuring the brake and has to spend one counter repeatedly. No ordering
// requirement is left — see e2e/helpers/rateLimit.ts.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('public application is accepted, creates no User, sets consentAt, and notifies admins', async ({ request }) => {
  const email = uniqueEmail('mentor-app');
  const admin = await seedUser(uniqueEmail('mentor-app-admin'), 'AdminPass123', 'ADMIN', 'MA Admin');

  try {
    const res = await request.post('/api/mentor-applications', {
      headers: freshIp('mentor-app accepted'),
      data: {
        fullName: 'New Mentor',
        email,
        expertise: 'React, Node.js',
        motivation: 'I want to help junior developers grow.',
      },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const application = await prisma.mentorApplication.findFirst({ where: { email } });
    expect(application).toBeTruthy();
    expect(application!.status).toBe('PENDING');
    expect(application!.consentAt).not.toBeNull();
    expect(application!.expertise).toEqual(['React', 'Node.js']);

    // No account is created — approval (a later task) is what does that.
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();

    // Notification types are event keys since #1251 (`mentor_application.new`).
    await expect
      .poll(async () => prisma.notification.count({ where: { userId: admin.id, type: 'mentor_application.new' } }), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    const notification = await prisma.notification.findFirst({ where: { userId: admin.id, type: 'mentor_application.new' } });
    expect(notification?.link).toBe('/admin/mentor-applications');
  } finally {
    await prisma.notification.deleteMany({ where: { userId: admin.id } });
    await prisma.mentorApplication.deleteMany({ where: { email } });
    await cleanupByEmail(admin.email);
  }
});

test('a second application while one is PENDING is rejected with 409', async ({ request }) => {
  const email = uniqueEmail('mentor-app-dup');

  try {
    const first = await request.post('/api/mentor-applications', { data: { fullName: 'Dup Mentor', email }, headers: freshIp('mentor-app duplicate 1') });
    expect(first.status()).toBe(200);

    const second = await request.post('/api/mentor-applications', { data: { fullName: 'Dup Mentor', email }, headers: freshIp('mentor-app duplicate 2') });
    expect(second.status()).toBe(409);

    expect(await prisma.mentorApplication.count({ where: { email } })).toBe(1);
  } finally {
    await prisma.mentorApplication.deleteMany({ where: { email } });
  }
});

test('an email already tied to an account gets the same neutral response and no application is created', async ({
  request,
}) => {
  const email = uniqueEmail('mentor-app-existing');
  await seedUser(email, 'ExistingPass123', 'MENTEE', 'Existing User');

  try {
    const res = await request.post('/api/mentor-applications', { data: { fullName: 'Existing User', email }, headers: freshIp('mentor-app existing user') });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await prisma.mentorApplication.count({ where: { email } })).toBe(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('GET is admin-only; an admin can filter by status and gets a paginated shape', async ({ page }) => {
  const menteeEmail = uniqueEmail('mentor-app-mentee');
  const adminEmail = uniqueEmail('mentor-app-list-admin');
  const pw = 'ListPass123';
  await seedUser(menteeEmail, pw, 'MENTEE', 'List Mentee');
  await seedUser(adminEmail, pw, 'ADMIN', 'List Admin');

  const pendingEmail = uniqueEmail('mentor-app-seeded-pending');
  const rejectedEmail = uniqueEmail('mentor-app-seeded-rejected');
  await prisma.mentorApplication.createMany({
    data: [
      { fullName: 'Seeded Pending', email: pendingEmail, status: 'PENDING', expertise: [], consentAt: new Date() },
      { fullName: 'Seeded Rejected', email: rejectedEmail, status: 'REJECTED', expertise: [], consentAt: new Date() },
    ],
  });

  try {
    await signInAsFreshUser(page, menteeEmail, pw, '/portal');
    const forbidden = await page.request.get('/api/mentor-applications');
    expect(forbidden.status()).toBe(403);

    await signInAsFreshUser(page, adminEmail, pw, '/admin');

    const pending = await (await page.request.get('/api/mentor-applications?status=PENDING')).json();
    const pendingEmails = (pending.items as { email: string }[]).map((i) => i.email);
    expect(pendingEmails).toContain(pendingEmail);
    expect(pendingEmails).not.toContain(rejectedEmail);
    expect(pending.page).toBe(1);
    expect(pending.pageSize).toBeGreaterThan(0);
    expect(pending.total).toBeGreaterThanOrEqual(1);

    const rejected = await (await page.request.get('/api/mentor-applications?status=REJECTED')).json();
    const rejectedEmails = (rejected.items as { email: string }[]).map((i) => i.email);
    expect(rejectedEmails).toContain(rejectedEmail);
    expect(rejectedEmails).not.toContain(pendingEmail);
  } finally {
    await prisma.mentorApplication.deleteMany({ where: { email: { in: [pendingEmail, rejectedEmail] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('excess requests to the public endpoint are rate limited (429)', async ({ request }) => {
  // This one owns an address, so the six requests below are the only thing that
  // has ever touched its counter — the assertion is about the limiter and
  // nothing else, and it no longer needs the tests above it to have run first.
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await request.post('/api/mentor-applications', {
      headers: floodIp('mentor-application'),
      data: { fullName: 'Flood Mentor', email: uniqueEmail(`mentor-app-flood-${i}`) },
    });
    statuses.push(res.status());
  }
  expect(statuses).toContain(429);
});
