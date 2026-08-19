import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('invitations persist, can be resent and cancelled', async ({ page }) => {
  const adminEmail = uniqueEmail('inv-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Inv Admin');
  const inviteeEmail = uniqueEmail('inv-target');
  let inviteId = '';

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Send an invitation.
    const sent = await page.request.post('/api/invite', { data: { email: inviteeEmail, role: 'MENTOR' } });
    expect(sent.status()).toBe(201);
    inviteId = (await sent.json()).invitationId;

    // It persists in the list (survives refresh — it's server-backed).
    const list1 = await (await page.request.get('/api/invite')).json();
    expect(list1.invitations.some((i: { id: string }) => i.id === inviteId)).toBeTruthy();

    // Resend works and keeps the invite valid.
    const resend = await page.request.post(`/api/invite/${inviteId}`);
    expect(resend.ok()).toBeTruthy();
    expect((await resend.json()).registerUrl).toContain('/auth/register?token=');

    // Cancel removes it.
    const del = await page.request.delete(`/api/invite/${inviteId}`);
    expect(del.ok()).toBeTruthy();
    const list2 = await (await page.request.get('/api/invite')).json();
    expect(list2.invitations.some((i: { id: string }) => i.id === inviteId)).toBeFalsy();
    inviteId = '';
  } finally {
    if (inviteId) await prisma.invitationToken.deleteMany({ where: { id: inviteId } });
    await prisma.invitationToken.deleteMany({ where: { email: inviteeEmail } });
    await cleanupByEmail(adminEmail);
  }
});

// #942: a MENTEE invite may pre-link a mentor (`mentorId`) — advisory only,
// mirrors POST /api/mentorship and the request-approval endpoint's use of
// getMentorAvailability(). Never blocks: the invitation is created either way.
test('inviting a mentee with an at-capacity mentor pre-linked still creates the invite, with a mentor_at_capacity warning', async ({ page }) => {
  const adminEmail = uniqueEmail('inv-cap-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Inv Cap Admin');
  const mentor = await seedUser(uniqueEmail('inv-cap-mentor'), 'x', 'MENTOR', 'Inv Cap Mentor');
  const existingMentee = await seedUser(uniqueEmail('inv-cap-existing-mentee'), 'x', 'MENTEE', 'Inv Cap Existing Mentee');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 1 } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: existingMentee.id, orgId: existingMentee.orgId, status: 'ACTIVE', startDate: new Date() },
  });
  const inviteeEmail = uniqueEmail('inv-cap-invitee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const sent = await page.request.post('/api/invite', {
      data: { email: inviteeEmail, role: 'MENTEE', mentorId: mentor.id },
    });
    expect(sent.status()).toBe(201);
    const body = await sent.json();
    expect(body.warnings).toEqual(['mentor_at_capacity']);

    const token = await prisma.invitationToken.findFirst({ where: { email: inviteeEmail } });
    expect(token?.mentorId).toBe(mentor.id);
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: inviteeEmail } });
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(mentor.email);
    await cleanupByEmail(existingMentee.email);
    await cleanupByEmail(adminEmail);
  }
});

test('inviting a mentee with a not-accepting mentor pre-linked still creates the invite, with a mentor_not_accepting warning', async ({ page }) => {
  const adminEmail = uniqueEmail('inv-acc-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Inv Acc Admin');
  const mentor = await seedUser(uniqueEmail('inv-acc-mentor'), 'x', 'MENTOR', 'Inv Acc Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 10, acceptingMentees: false } });
  const inviteeEmail = uniqueEmail('inv-acc-invitee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const sent = await page.request.post('/api/invite', {
      data: { email: inviteeEmail, role: 'MENTEE', mentorId: mentor.id },
    });
    expect(sent.status()).toBe(201);
    const body = await sent.json();
    expect(body.warnings).toEqual(['mentor_not_accepting']);

    const token = await prisma.invitationToken.findFirst({ where: { email: inviteeEmail } });
    expect(token?.mentorId).toBe(mentor.id);
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: inviteeEmail } });
    await cleanupByEmail(mentor.email);
    await cleanupByEmail(adminEmail);
  }
});

test('inviting a mentee with an available mentor pre-linked creates the invite with no warnings', async ({ page }) => {
  const adminEmail = uniqueEmail('inv-avail-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Inv Avail Admin');
  const mentor = await seedUser(uniqueEmail('inv-avail-mentor'), 'x', 'MENTOR', 'Inv Avail Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 5, acceptingMentees: true } });
  const inviteeEmail = uniqueEmail('inv-avail-invitee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const sent = await page.request.post('/api/invite', {
      data: { email: inviteeEmail, role: 'MENTEE', mentorId: mentor.id },
    });
    expect(sent.status()).toBe(201);
    const body = await sent.json();
    expect(body.warnings).toEqual([]);

    const token = await prisma.invitationToken.findFirst({ where: { email: inviteeEmail } });
    expect(token?.mentorId).toBe(mentor.id);
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: inviteeEmail } });
    await cleanupByEmail(mentor.email);
    await cleanupByEmail(adminEmail);
  }
});

test('inviting without a mentor pre-linked creates the invite with no warnings', async ({ page }) => {
  const adminEmail = uniqueEmail('inv-none-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Inv None Admin');
  const inviteeEmail = uniqueEmail('inv-none-invitee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const sent = await page.request.post('/api/invite', { data: { email: inviteeEmail, role: 'MENTOR' } });
    expect(sent.status()).toBe(201);
    const body = await sent.json();
    expect(body.warnings).toEqual([]);
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: inviteeEmail } });
    await cleanupByEmail(adminEmail);
  }
});
