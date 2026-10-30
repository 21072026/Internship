import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Prisma } from '@prisma/client';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { notifyEvent } from '@/lib/notifications/router';
import { setChatClientsForTests, type ChatMember, type ChatPlatformClient } from '@/lib/chat/client';
import { proposeIdentitiesForWorkspace } from '@/lib/chat/identity';
import { recordChatInstall } from '@/lib/chat/workspaces';

// Chat identity linking (#1937): propose → confirm → deliver → revoke → no
// longer delivered.
//
//  · a proposal needs a verified address on BOTH sides; an unverified account,
//    an unknown address or a member without one creates no row and no user;
//  · two CRM users can never claim the same member, and one user one member
//    per workspace — both unique constraints exercised, not just declared;
//  · nothing is delivered before the person confirms; after they disconnect,
//    chat stops and e-mail still goes;
//  · a person acts on their own identity only (403 otherwise), an admin on
//    their org's.

const PW = 'ChatIdentity123!';

test.beforeAll(() => {
  process.env.CHAT_APPS_ENABLED = '1';
  process.env.NEXTAUTH_SECRET ||= 'unit-test-secret-not-for-production';
});
test.afterAll(async () => {
  setChatClientsForTests({});
  await prisma.$disconnect();
});

test('propose → confirm → deliver → revoke → no longer delivered', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `ChatId ${stamp}`, slug: `chatid-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `ChatId O ${stamp}`, slug: `chatid-o-${stamp}` } });
  const emails = {
    admin: uniqueEmail('chatid-admin'),
    mentor: uniqueEmail('chatid-mentor'),
    unverified: uniqueEmail('chatid-unverified'),
    bystander: uniqueEmail('chatid-bystander'),
    foreignAdmin: uniqueEmail('chatid-foreign'),
    stranger: uniqueEmail('chatid-stranger'),
  };
  const admin = await seedUser(emails.admin, PW, 'ADMIN', 'ChatId Admin', { orgId: org.id });
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'ChatId Mentor', { orgId: org.id });
  const unverified = await seedUser(emails.unverified, PW, 'MENTOR', 'ChatId Unverified', { orgId: org.id });
  await prisma.user.update({ where: { id: unverified.id }, data: { emailVerified: false } });
  const bystander = await seedUser(emails.bystander, PW, 'MENTOR', 'ChatId Bystander', { orgId: org.id });
  await seedUser(emails.foreignAdmin, PW, 'ADMIN', 'ChatId Foreign', { orgId: other.id });

  const members: ChatMember[] = [
    { externalUserId: `UM${stamp}`, displayName: 'Mentor In Slack', verifiedEmail: emails.mentor.toLowerCase() },
    // A second member with the same address: the user already has a member here.
    { externalUserId: `UM2${stamp}`, displayName: 'Mentor Again', verifiedEmail: emails.mentor.toLowerCase() },
    { externalUserId: `UU${stamp}`, displayName: 'Unverified', verifiedEmail: emails.unverified.toLowerCase() },
    { externalUserId: `US${stamp}`, displayName: 'Stranger', verifiedEmail: emails.stranger.toLowerCase() },
    { externalUserId: `UN${stamp}`, displayName: 'No Address', verifiedEmail: null },
  ];
  const posts: string[] = [];
  const client: ChatPlatformClient = {
    async postMessage({ target }) {
      posts.push(target.id);
      return { externalMessageId: `m${posts.length}` };
    },
    async updateMessage() {},
    async openDm({ externalUserId }) {
      return { id: `D-${externalUserId}` };
    },
    async revoke() {
      return { revoked: true };
    },
    async listMembers() {
      return members;
    },
  };
  setChatClientsForTests({ SLACK: client });

  const ctxs: APIRequestContext[] = [];
  const as = async (email: string) => {
    const ctx = await playwright.request.newContext({ baseURL });
    ctxs.push(ctx);
    expect((await signInViaApi(ctx, email, PW, { headers: freshIp(`chatid-${email}`) })).error).toBeNull();
    return ctx;
  };
  let wsId = '';
  try {
    wsId = (await recordChatInstall({ orgId: org.id, platform: 'SLACK', externalId: `T${stamp}`, name: 'Acme Identity', botToken: 'xoxb-synthetic-id', scope: 'users:read.email', installedById: admin.id })).id;

    // 1. PROPOSE: exactly one row, for the verified match; no user created.
    const usersBefore = await prisma.user.count();
    const r = await proposeIdentitiesForWorkspace(org.id, wsId, client);
    expect(r).toEqual({ proposed: 1, alreadyLinked: 1, unmatched: 3 });
    expect(await prisma.user.count()).toBe(usersBefore);
    const rows = await prisma.chatIdentity.findMany({ where: { workspaceId: wsId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: mentor.id, externalUserId: `UM${stamp}`, displayName: 'Mentor In Slack', verifiedAt: null, orgId: org.id });
    const identityId = rows[0].id;
    // Idempotent, and another org's admin cannot propose into this workspace.
    expect(await proposeIdentitiesForWorkspace(org.id, wsId, client)).toEqual({ proposed: 0, alreadyLinked: 2, unmatched: 3 });
    await expect(proposeIdentitiesForWorkspace(other.id, wsId, client)).rejects.toThrow('not_found');
    // The unique constraint on the member, exercised: nobody else can claim UM.
    await expect(
      prisma.chatIdentity.create({ data: { orgId: org.id, workspaceId: wsId, userId: bystander.id, externalUserId: `UM${stamp}` } }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

    // 2. Not confirmed yet: nothing is delivered over chat.
    await notifyEvent(mentor.id, 'deadline.stagePassed', { menteeName: 'Before', relationId: 'rel-a' }, { dedupeKey: `a-${stamp}` });
    expect(posts).toHaveLength(0);

    // 3. CONFIRM — only by the person; someone else's is not theirs to touch.
    const by = await as(emails.bystander);
    expect((await by.post('/api/integrations/chat/identity', { data: { identityId } })).status()).toBe(404);
    expect((await by.delete('/api/integrations/chat/identity', { data: { identityId } })).status()).toBe(403);
    const fa = await as(emails.foreignAdmin);
    expect((await fa.delete('/api/integrations/chat/identity', { data: { identityId } })).status()).toBe(403);
    expect((await by.get('/api/integrations/chat/identity')).ok()).toBe(true);
    expect((await (await by.get('/api/integrations/chat/identity')).json()).items).toEqual([]);

    expect((await signInViaApi(page.request, emails.mentor, PW, { headers: freshIp('chatid-ui') })).error).toBeNull();
    await gotoSettled(page, '/account');
    const card = page.getByTestId(`chat-identity-${identityId}`);
    await expect(card).toHaveAttribute('data-confirmed', '0', { timeout: 20_000 });
    await expect(card).toContainText('Connected to Acme Identity (Slack) as Mentor In Slack');
    const [confirmed] = await Promise.all([
      page.waitForResponse((res) => res.url().endsWith('/api/integrations/chat/identity') && res.request().method() === 'POST', { timeout: 30_000 }),
      page.getByTestId(`chat-identity-confirm-${identityId}`).click(),
    ]);
    expect(confirmed.status()).toBe(200);
    await expect(card).toHaveAttribute('data-confirmed', '1', { timeout: 15_000 });
    expect((await prisma.chatIdentity.findUniqueOrThrow({ where: { id: identityId } })).verifiedAt).not.toBeNull();

    // 4. DELIVER: now chat rides along, to the DM opened for that member.
    await notifyEvent(mentor.id, 'deadline.stagePassed', { menteeName: 'After', relationId: 'rel-b' }, { dedupeKey: `b-${stamp}` });
    expect(posts).toEqual([`D-UM${stamp}`]);

    // 5. REVOKE by the person; then chat stops and e-mail still goes.
    const m = await as(emails.mentor);
    expect((await m.delete('/api/integrations/chat/identity', { data: { identityId } })).status()).toBe(200);
    expect(await prisma.chatIdentity.count({ where: { id: identityId } })).toBe(0);
    const t0 = new Date(Date.now() - 1);
    await notifyEvent(mentor.id, 'deadline.stagePassed', { menteeName: 'Gone', relationId: 'rel-c' }, { dedupeKey: `c-${stamp}` });
    expect(posts).toHaveLength(1);
    const last = await prisma.notificationDelivery.findMany({ where: { userId: mentor.id, createdAt: { gte: t0 } }, select: { channel: true } });
    expect(last.map((x) => x.channel).sort()).toEqual(['email', 'inApp']);

    // 6. An admin may remove a link of their own org.
    const again = await prisma.chatIdentity.create({ data: { orgId: org.id, workspaceId: wsId, userId: bystander.id, externalUserId: `UB${stamp}` } });
    const a = await as(emails.admin);
    expect((await a.delete('/api/integrations/chat/identity', { data: { identityId: again.id } })).status()).toBe(200);
    expect(await prisma.chatIdentity.count({ where: { id: again.id } })).toBe(0);
  } finally {
    for (const c of ctxs) await c.dispose();
    const ids = (await prisma.user.findMany({ where: { email: { in: Object.values(emails) } }, select: { id: true } })).map((u) => u.id);
    await prisma.notificationDelivery.deleteMany({ where: { userId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.chatDelivery.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    await prisma.chatWorkspace.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    await prisma.auditLog.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } });
  }
});
