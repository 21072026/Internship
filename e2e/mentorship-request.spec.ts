import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

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
