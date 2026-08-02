import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * Invitations that connect people, and referral links that record who brought
 * someone in (#51).
 *
 * Registration is driven through the API here on purpose: the point under test
 * is what the *server* writes (the mentorship, the project membership, the
 * referral pointer), not the sign-up form.
 */

const password = 'InviteLink123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an invitation carrying a mentor connects the two on registration', { tag: '@smoke' }, async ({ request }) => {
  const adminEmail = uniqueEmail('link-admin');
  const mentorEmail = uniqueEmail('link-mentor');
  const inviteeEmail = uniqueEmail('link-invitee');
  const admin = await seedUser(adminEmail, password, 'ADMIN', 'Link Admin');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Link Mentor');

  const project = await prisma.project.create({
    data: {
      name: `Invite Project ${Date.now()}`,
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      members: { create: [{ userId: mentor.id, role: 'OWNER' }] },
    },
  });

  const token = crypto.randomBytes(32).toString('hex');
  await prisma.invitationToken.create({
    data: {
      token,
      email: inviteeEmail,
      role: 'MENTEE',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedById: admin.id,
      mentorId: mentor.id,
      projectId: project.id,
    },
  });

  try {
    const res = await request.post('/api/register', {
      data: { token, email: inviteeEmail, password, fullName: 'Link Invitee', consent: true },
    });
    expect(res.status()).toBe(201);

    const invitee = await prisma.user.findUnique({ where: { email: inviteeEmail } });
    expect(invitee).toBeTruthy();
    // The admin who sent the invitation is the recorded source.
    expect(invitee!.referredById).toBe(admin.id);

    // Mentorship and project membership exist without any follow-up step.
    const relation = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: invitee!.id },
    });
    expect(relation).toBeTruthy();
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: invitee!.id } },
    });
    expect(membership?.role).toBe('MENTEE');
  } finally {
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(inviteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('a mentee referral link credits the mentee who shared it', async ({ request }) => {
  const referrerEmail = uniqueEmail('ref-mentee');
  const newcomerEmail = uniqueEmail('ref-newcomer');
  const referrer = await seedUser(referrerEmail, password, 'MENTEE', 'Referring Mentee');

  // The code is normally minted by GET /api/referral; set it directly so the
  // test does not depend on the dashboard rendering.
  const code = 'E2EREF' + crypto.randomBytes(2).toString('hex').toUpperCase();
  await prisma.user.update({ where: { id: referrer.id }, data: { referralCode: code } });

  try {
    const res = await request.post('/api/register', {
      data: { ref: code, email: newcomerEmail, password, fullName: 'Referred Newcomer', consent: true },
    });
    expect(res.status()).toBe(201);

    const newcomer = await prisma.user.findUnique({ where: { email: newcomerEmail } });
    expect(newcomer?.referredById).toBe(referrer.id);
    // Open registration still lands pending approval — the referral changes the
    // recorded source, not the approval rules.
    expect(newcomer?.isActive).toBe(false);
  } finally {
    await cleanupByEmail(newcomerEmail);
    await cleanupByEmail(referrerEmail);
  }
});
