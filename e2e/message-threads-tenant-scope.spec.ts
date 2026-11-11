import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Message threads stay inside the caller's org (#3602). An admin may open a
// thread they are not in — but only in their own tenant: the helpers behind
// every message route (getThreadIfAllowed, getConversationIfAllowed) used to
// let ANY admin in, and the tenant middleware is off in every deployment. Here
// an admin of org A must not read or post into org B's relation thread or B's
// DIRECT conversation (flag off, as in every deployment).

const PASSWORD = 'ThreadScope123!';

test.afterAll(async () => prisma.$disconnect());

test('message threads: another org\'s relation thread and DIRECT conversation are refused to an admin', { tag: '@smoke' }, async () => {
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `MT A ${s}`, slug: `mt-a-${s}`, plan: 'ENTERPRISE' } });
  const orgB = await prisma.organization.create({ data: { name: `MT B ${s}`, slug: `mt-b-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['mt-a-admin', 'mt-a-mentor', 'mt-a-mentee', 'mt-b-mentor', 'mt-b-mentee'].map((p) => uniqueEmail(p).toLowerCase());
  const [aAdmin, aMentor, aMentee, bMentor, bMentee] = emails;
  const secret = `Foreign message ${s}`;
  let conversationId: string | null = null;
  try {
    const adminA = await seedUser(aAdmin, PASSWORD, 'ADMIN', 'MT A Admin', orgA.id);
    await prisma.user.update({ where: { id: adminA.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const am = await seedUser(aMentor, PASSWORD, 'MENTOR', 'MT A Mentor', orgA.id);
    const ae = await seedUser(aMentee, PASSWORD, 'MENTEE', 'MT A Mentee', orgA.id);
    const bm = await seedUser(bMentor, PASSWORD, 'MENTOR', 'MT B Mentor', orgB.id);
    const be = await seedUser(bMentee, PASSWORD, 'MENTEE', 'MT B Mentee', orgB.id);
    const aRel = await prisma.mentorshipRelation.create({ data: { orgId: orgA.id, mentorId: am.id, menteeId: ae.id } });
    const bRel = await prisma.mentorshipRelation.create({ data: { orgId: orgB.id, mentorId: bm.id, menteeId: be.id } });
    await prisma.message.create({ data: { relationId: aRel.id, senderId: am.id, body: `Own message ${s}` } });
    await prisma.message.create({ data: { relationId: bRel.id, senderId: bm.id, body: secret } });
    const conversation = await prisma.conversation.create({
      data: { type: 'DIRECT', participants: { create: [{ userId: bm.id }, { userId: be.id }] } },
    });
    conversationId = conversation.id;
    await prisma.message.create({ data: { conversationId, senderId: bm.id, body: secret } });

    const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
    const signed = await signInViaApi(ctx, aAdmin, PASSWORD);
    expect(signed.ok, `sign-in failed: ${signed.error}`).toBe(true);

    // Negative control: the admin opens a thread of their own org they are not in.
    const own = await ctx.get(`/api/messages?relationId=${aRel.id}`);
    expect(own.status()).toBe(200);
    expect(await own.text()).toContain(`Own message ${s}`);

    // Another org's relation thread and DIRECT conversation: refused, nothing read.
    for (const query of [`relationId=${bRel.id}`, `conversationId=${conversationId}`]) {
      const res = await ctx.get(`/api/messages?${query}`);
      expect(res.status(), query).not.toBe(200);
      expect(await res.text()).not.toContain(secret);
    }
    // …and nothing written.
    expect((await ctx.post('/api/messages', { data: { relationId: bRel.id, body: 'across tenants' } })).status()).not.toBe(201);
    expect((await ctx.post('/api/messages', { data: { conversationId, body: 'across tenants' } })).status()).not.toBe(201);
    expect(await prisma.message.count({ where: { body: 'across tenants' } })).toBe(0);
    await ctx.dispose();
  } finally {
    await prisma.message.deleteMany({ where: { body: { endsWith: s } } });
    if (conversationId) await prisma.conversation.deleteMany({ where: { id: conversationId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    for (const e of emails) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
