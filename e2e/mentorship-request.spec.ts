import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #590: a mentee requests mentorship (one PENDING at a time), the admin queue
// approves with a mentor → MentorshipRelation is created and the request
// becomes APPROVED. Driven via the authenticated APIs.
test('mentee request → admin approve creates the relation; duplicate pending is blocked', async ({ browser }) => {
  const menteeEmail = uniqueEmail('req-mentee');
  const adminEmail = uniqueEmail('req-admin');
  const mentorEmail = uniqueEmail('req-mentor');
  const pw = 'RequestPass123';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Request Mentee');
  // Complete the onboarding gate (#591): profile basics + an uploaded CV.
  await prisma.user.update({ where: { id: mentee.id }, data: { university: 'Test University', skills: ['React'] } });
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });
  await seedUser(adminEmail, pw, 'ADMIN', 'Request Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Request Mentor');

  const menteeCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  try {
    // Mentee signs in and submits a request from the portal panel's API.
    const menteePage = await menteeCtx.newPage();
    await menteePage.goto('/auth/signin');
    await menteePage.fill('input[type="email"], input[name="email"]', menteeEmail);
    await menteePage.fill('input[type="password"]', pw);
    await menteePage.click('button[type="submit"]');
    await menteePage.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // The panel renders on the dashboard for an unassigned mentee.
    await expect(menteePage.getByTestId('mentorship-request')).toBeVisible({ timeout: 10_000 });

    const created = await menteePage.request.post('/api/mentorship-requests', {
      data: { message: 'Looking for a backend mentor.' },
    });
    expect(created.status()).toBe(201);

    // A second request while one is pending is blocked.
    const dup = await menteePage.request.post('/api/mentorship-requests', { data: {} });
    expect(dup.status()).toBe(409);
    expect((await dup.json()).code).toBe('already_pending');

    // Admin sees it in the queue and approves with a mentor.
    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/auth/signin');
    await adminPage.fill('input[type="email"], input[name="email"]', adminEmail);
    await adminPage.fill('input[type="password"]', pw);
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const list = await (await adminPage.request.get('/api/admin/mentorship-requests')).json();
    const mine = (list.requests as { id: string; mentee: { id: string } }[]).find((r) => r.mentee.id === mentee.id);
    expect(mine).toBeTruthy();

    const approve = await adminPage.request.put('/api/admin/mentorship-requests', {
      data: { requestId: mine!.id, action: 'approve', mentorId: mentor.id },
    });
    expect(approve.ok()).toBeTruthy();

    // Relation exists; request is APPROVED; mentee got notified.
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: mentee.id, mentorId: mentor.id, status: 'ACTIVE' } })).toBe(1);
    const after = await prisma.mentorshipRequest.findUnique({ where: { id: mine!.id } });
    expect(after!.status).toBe('APPROVED');
    expect(await prisma.notification.count({ where: { userId: mentee.id, type: 'mentorship_request' } })).toBeGreaterThanOrEqual(1);

    // With an active mentorship, further requests are blocked.
    const again = await menteePage.request.post('/api/mentorship-requests', { data: {} });
    expect(again.status()).toBe(409);
    expect((await again.json()).code).toBe('already_mentored');
  } finally {
    await menteeCtx.close();
    await adminCtx.close();
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

// #668: creating a request should notify every active admin in-app.
test('mentee request notifies active admins in-app', async ({ page }) => {
  const menteeEmail = uniqueEmail('notify-mentee');
  const adminEmail = uniqueEmail('notify-admin');
  const pw = 'NotifyPass123';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Notify Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { university: 'Test University', skills: ['React'] } });
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Notify Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const created = await page.request.post('/api/mentorship-requests', {
      data: { message: 'Looking for a frontend mentor.' },
    });
    expect(created.status()).toBe(201);
    const requestId = (await created.json()).request.id;

    const stored = await prisma.mentorshipRequest.findUnique({ where: { id: requestId } });
    expect(stored).toBeTruthy();
    expect(stored?.status).toBe('PENDING');

    // notify() in src/app/api/mentorship-requests/route.ts uses type 'mentorship_request'.
    await expect
      .poll(async () => prisma.notification.count({ where: { userId: admin.id, type: 'mentorship_request' } }), { timeout: 10_000 })
      .toBeGreaterThan(0);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: admin.id } });
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

// #668: approving a request should create the relation and notify both the
// mentee and the newly assigned mentor in-app.
test('admin approves a mentorship request and both mentor and mentee are notified', async ({ browser }) => {
  const menteeEmail = uniqueEmail('approve-mentee');
  const adminEmail = uniqueEmail('approve-admin');
  const mentorEmail = uniqueEmail('approve-mentor');
  const pw = 'ApprovePass123';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Approve Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { university: 'Test University', skills: ['React'] } });
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Approve Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Approve Mentor');

  const menteeCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  let requestId = '';
  try {
    const menteePage = await menteeCtx.newPage();
    await menteePage.goto('/auth/signin');
    await menteePage.fill('input[type="email"], input[name="email"]', menteeEmail);
    await menteePage.fill('input[type="password"]', pw);
    await menteePage.click('button[type="submit"]');
    await menteePage.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const created = await menteePage.request.post('/api/mentorship-requests', { data: {} });
    expect(created.status()).toBe(201);
    requestId = (await created.json()).request.id;

    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/auth/signin');
    await adminPage.fill('input[type="email"], input[name="email"]', adminEmail);
    await adminPage.fill('input[type="password"]', pw);
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const approve = await adminPage.request.put('/api/admin/mentorship-requests', {
      data: { requestId, action: 'approve', mentorId: mentor.id },
    });
    expect(approve.ok()).toBeTruthy();

    const after = await prisma.mentorshipRequest.findUnique({ where: { id: requestId } });
    expect(after?.status).toBe('APPROVED');

    const relation = await prisma.mentorshipRelation.findFirst({
      where: { menteeId: mentee.id, mentorId: mentor.id, status: 'ACTIVE' },
    });
    expect(relation).toBeTruthy();

    // notify() in src/app/api/admin/mentorship-requests/route.ts uses type 'mentorship_request'.
    await expect
      .poll(async () => prisma.notification.count({ where: { userId: mentor.id, type: 'mentorship_request' } }), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => prisma.notification.count({ where: { userId: mentee.id, type: 'mentorship_request' } }), { timeout: 10_000 })
      .toBeGreaterThan(0);
  } finally {
    await menteeCtx.close();
    await adminCtx.close();
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    if (requestId) await prisma.mentorshipRequest.deleteMany({ where: { id: requestId } });
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id, mentorId: mentor.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

// #668: rejecting a request should notify the mentee and must not create a relation.
test('admin rejects a mentorship request and the mentee is notified with no relation created', async ({ page }) => {
  const menteeEmail = uniqueEmail('reject-mentee');
  const adminEmail = uniqueEmail('reject-admin');
  const pw = 'RejectPass123';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Reject Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { university: 'Test University', skills: ['React'] } });
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Reject Admin');

  let requestId = '';
  try {
    await signInAsFreshUser(page, menteeEmail, pw, '/portal');

    const created = await page.request.post('/api/mentorship-requests', { data: {} });
    expect(created.status()).toBe(201);
    requestId = (await created.json()).request.id;

    await signInAsFreshUser(page, adminEmail, pw, '/admin');

    const reject = await page.request.put('/api/admin/mentorship-requests', {
      data: { requestId, action: 'reject' },
    });
    expect(reject.ok()).toBeTruthy();

    const after = await prisma.mentorshipRequest.findUnique({ where: { id: requestId } });
    expect(after?.status).toBe('REJECTED');

    const relation = await prisma.mentorshipRelation.findFirst({ where: { menteeId: mentee.id } });
    expect(relation).toBeNull();

    // notify() in src/app/api/admin/mentorship-requests/route.ts uses type 'mentorship_request'.
    await expect
      .poll(async () => prisma.notification.count({ where: { userId: mentee.id, type: 'mentorship_request' } }), { timeout: 10_000 })
      .toBeGreaterThan(0);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: mentee.id } });
    if (requestId) await prisma.mentorshipRequest.deleteMany({ where: { id: requestId } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
