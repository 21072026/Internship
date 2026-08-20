import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #668: an admin directly assigning a mentor to a mentee (no prior request)
// should create the MentorshipRelation and notify both sides in-app.
test('admin directly assigns a mentor to a mentee and both are notified in-app', async ({ page }) => {
  const adminEmail = uniqueEmail('assign-admin');
  const mentorEmail = uniqueEmail('assign-mentor');
  const menteeEmail = uniqueEmail('assign-mentee');
  const pw = 'AssignPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Assign Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Assign Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Assign Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/mentorship', {
      data: { mentorId: mentor.id, menteeId: mentee.id },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.relation.mentorId).toBe(mentor.id);
    expect(body.relation.menteeId).toBe(mentee.id);

    const relation = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: mentee.id },
    });
    expect(relation).toBeTruthy();

    // notify() calls in src/app/api/mentorship/route.ts emit
    // 'mentorship_request.menteeAssigned' (mentor) and 'mentorship_request.mentorAssigned' (mentee).
    await expect
      .poll(async () => prisma.notification.count({ where: { userId: mentor.id, type: 'mentorship_request.menteeAssigned' } }), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => prisma.notification.count({ where: { userId: mentee.id, type: 'mentorship_request.mentorAssigned' } }), { timeout: 10_000 })
      .toBeGreaterThan(0);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id, menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

// #942: the assignment still goes through when the mentor is over/at capacity
// or has switched acceptingMentees off — these are advisory warnings on the
// 201 response, never a block. See src/lib/mentorAvailability.ts.
test('assigning a mentor already at capacity still succeeds, with a mentor_at_capacity warning', async ({ page }) => {
  const adminEmail = uniqueEmail('cap-admin');
  const mentorEmail = uniqueEmail('cap-mentor');
  const existingMenteeEmail = uniqueEmail('cap-existing-mentee');
  const newMenteeEmail = uniqueEmail('cap-new-mentee');
  const pw = 'AssignPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Cap Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Cap Mentor');
  const existingMentee = await seedUser(existingMenteeEmail, pw, 'MENTEE', 'Cap Existing Mentee');
  const newMentee = await seedUser(newMenteeEmail, pw, 'MENTEE', 'Cap New Mentee');

  // Capacity of 1, already filled by one ACTIVE relation.
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 1 } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: existingMentee.id, orgId: existingMentee.orgId, status: 'ACTIVE', startDate: new Date() },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/mentorship', {
      data: { mentorId: mentor.id, menteeId: newMentee.id },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.warnings).toEqual(['mentor_at_capacity']);

    const relation = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: newMentee.id },
    });
    expect(relation).toBeTruthy();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(newMenteeEmail);
    await cleanupByEmail(existingMenteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('assigning a mentor with acceptingMentees=false still succeeds, with a mentor_not_accepting warning', async ({ page }) => {
  const adminEmail = uniqueEmail('acc-admin');
  const mentorEmail = uniqueEmail('acc-mentor');
  const menteeEmail = uniqueEmail('acc-mentee');
  const pw = 'AssignPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Acc Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Acc Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Acc Mentee');

  // Plenty of capacity, but the mentor has explicitly paused new assignments.
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 10, acceptingMentees: false } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/mentorship', {
      data: { mentorId: mentor.id, menteeId: mentee.id },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.warnings).toEqual(['mentor_not_accepting']);

    const relation = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: mentee.id },
    });
    expect(relation).toBeTruthy();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id, menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('assigning an available mentor succeeds with no warnings', async ({ page }) => {
  const adminEmail = uniqueEmail('avail-admin');
  const mentorEmail = uniqueEmail('avail-mentor');
  const menteeEmail = uniqueEmail('avail-mentee');
  const pw = 'AssignPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Avail Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Avail Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Avail Mentee');

  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 5, acceptingMentees: true } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/mentorship', {
      data: { mentorId: mentor.id, menteeId: mentee.id },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.warnings).toEqual([]);

    const relation = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: mentee.id },
    });
    expect(relation).toBeTruthy();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id, menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
