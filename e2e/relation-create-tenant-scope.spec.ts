import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// User ids a request body names must be the caller's own tenant's (#3588). The
// tenant middleware is off in every deployment (and in this project), so the
// pairing, invitation and referral writes check the people themselves. An admin
// of org A must not pair, pre-link or credit org B's users.

const PASSWORD = 'PairScope123!';

test.afterAll(async () => prisma.$disconnect());

test('relation writes: another org\'s people are refused as mentor, mentee or referrer', { tag: '@smoke' }, async () => {
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `RC A ${s}`, slug: `rc-a-${s}`, plan: 'ENTERPRISE' } });
  const orgB = await prisma.organization.create({ data: { name: `RC B ${s}`, slug: `rc-b-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['rc-a-admin', 'rc-a-mentor', 'rc-a-mentee', 'rc-b-mentor', 'rc-b-mentee'].map((p) => uniqueEmail(p).toLowerCase());
  const [aAdmin, aMentor, aMentee, bMentor, bMentee] = emails;
  const inviteEmail = uniqueEmail('rc-invitee').toLowerCase();
  const createdMenteeEmail = uniqueEmail('rc-created').toLowerCase();
  try {
    const adminA = await seedUser(aAdmin, PASSWORD, 'ADMIN', 'RC A Admin', orgA.id);
    await prisma.user.update({ where: { id: adminA.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const am = await seedUser(aMentor, PASSWORD, 'MENTOR', 'RC A Mentor', orgA.id);
    const ae = await seedUser(aMentee, PASSWORD, 'MENTEE', 'RC A Mentee', orgA.id);
    const bm = await seedUser(bMentor, PASSWORD, 'MENTOR', 'RC B Mentor', orgB.id);
    const be = await seedUser(bMentee, PASSWORD, 'MENTEE', 'RC B Mentee', orgB.id);

    const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
    const signed = await signInViaApi(ctx, aAdmin, PASSWORD);
    expect(signed.ok, `sign-in failed: ${signed.error}`).toBe(true);

    // Pairing: a foreign mentee or a foreign mentor is invalid; nothing is created.
    expect((await ctx.post('/api/mentorship', { data: { mentorId: am.id, menteeId: be.id } })).status()).toBe(400);
    expect((await ctx.post('/api/mentorship', { data: { mentorId: bm.id, menteeId: ae.id } })).status()).toBe(400);
    expect(await prisma.mentorshipRelation.count({ where: { OR: [{ menteeId: be.id }, { mentorId: bm.id }] } })).toBe(0);

    // Invitations: another org's mentor or mentee cannot be pre-linked.
    expect((await ctx.post('/api/invite', { data: { email: inviteEmail, role: 'MENTEE', mentorId: bm.id } })).status()).toBe(400);
    expect((await ctx.post('/api/invite', { data: { email: inviteEmail, role: 'MENTOR', menteeId: be.id } })).status()).toBe(400);
    expect(await prisma.invitationToken.count({ where: { OR: [{ mentorId: bm.id }, { menteeId: be.id }] } })).toBe(0);

    // A referral cannot credit another org's person.
    expect((await ctx.post('/api/mentor/mentees', { data: { fullName: 'RC Created', email: createdMenteeEmail, referredById: bm.id } })).status()).toBe(400);
    expect(await prisma.user.count({ where: { email: createdMenteeEmail } })).toBe(0);

    // Negative control: the same pairing inside org A goes through.
    expect((await ctx.post('/api/mentorship', { data: { mentorId: am.id, menteeId: ae.id } })).status()).toBe(201);
    await ctx.dispose();
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: inviteEmail } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    for (const e of [...emails, createdMenteeEmail]) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
