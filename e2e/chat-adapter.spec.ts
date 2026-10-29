import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { notifyEvent } from '@/lib/notifications/router';
import { setChatClientsForTests, type ChatPlatformClient } from '@/lib/chat/client';
import { ChatClientError } from '@/lib/chat/client/errors';
import { sealBotToken } from '@/lib/chat/tokens';

// The `chat` channel on the notification router (#1939), in-process against a
// real database with a RECORDING platform client in place of Slack.
//
//  · one notifyEvent() call → in-app + e-mail as before, plus ONE chat
//    delivery for a person with a confirmed identity, and none for anybody else;
//  · the admin's kill switch (ChatWorkspace.enabled = false) turns the chat
//    delivery into a SKIPPED while the e-mail still goes — nobody loses it;
//  · a platform failure is a FAILED with its code and touches no other channel.

const PW = 'ChatAdapter123!';

type Post = { token: string; target: string; text: string };

function recordingClient(posts: Post[], failWith?: string): ChatPlatformClient {
  return {
    async postMessage({ token, target, text }) {
      if (failWith) throw new ChatClientError(failWith);
      posts.push({ token, target: target.id, text });
      return { externalMessageId: `ts-${posts.length}` };
    },
    async openDm({ externalUserId }) {
      return { id: `D-${externalUserId}` };
    },
    async revoke() {
      return { revoked: true };
    },
    async listMembers() {
      return [];
    },
  };
}

test.beforeAll(() => {
  process.env.CHAT_APPS_ENABLED = '1';
  process.env.NEXTAUTH_SECRET ||= 'unit-test-secret-not-for-production';
});

test.afterAll(async () => {
  setChatClientsForTests({});
  delete process.env.CHAT_APPS_ENABLED;
  await prisma.$disconnect();
});

test('chat rides along for a linked person; disabled and failing workspaces fall back silently', { tag: '@smoke' }, async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Chat Org ${stamp}`, slug: `chat-${stamp}` } });
  const emails = { linked: uniqueEmail('chat-linked'), unlinked: uniqueEmail('chat-unlinked'), unverified: uniqueEmail('chat-unverified'), admin: uniqueEmail('chat-admin') };
  const linked = await seedUser(emails.linked, PW, 'MENTOR', 'Chat Linked', { orgId: org.id });
  const unlinked = await seedUser(emails.unlinked, PW, 'MENTOR', 'Chat Unlinked', { orgId: org.id });
  const unverified = await seedUser(emails.unverified, PW, 'MENTOR', 'Chat Unverified', { orgId: org.id });
  const admin = await seedUser(emails.admin, PW, 'ADMIN', 'Chat Admin', { orgId: org.id });
  const ws = await prisma.chatWorkspace.create({
    data: {
      orgId: org.id, platform: 'SLACK', externalId: `T${stamp}`, name: 'Acme Slack', scope: 'chat:write,im:write',
      botTokenEnc: sealBotToken('xoxb-synthetic'), installedById: admin.id,
    },
  });
  await prisma.chatIdentity.createMany({
    data: [
      { orgId: org.id, workspaceId: ws.id, userId: linked.id, externalUserId: `U1${stamp}`, verifiedAt: new Date() },
      // Linked by somebody but never confirmed by the person: no chat.
      { orgId: org.id, workspaceId: ws.id, userId: unverified.id, externalUserId: `U2${stamp}` },
    ],
  });
  const posts: Post[] = [];
  setChatClientsForTests({ SLACK: recordingClient(posts) });

  try {
    // 1. Enabled workspace: one card, to the cached-on-first-use DM.
    const r1 = await notifyEvent([linked.id, unlinked.id, unverified.id], 'deadline.stagePassed', { menteeName: 'Aylin', relationId: 'rel-1' }, { dedupeKey: `a-${stamp}` });
    expect(r1.failed).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].token).toBe('xoxb-synthetic');
    expect(posts[0].target).toBe(`D-U1${stamp}`);
    expect(posts[0].text).toContain('Aylin');
    expect(posts[0].text).toContain('/mentor/mentees/rel-1');
    const l1 = await prisma.notificationDelivery.findMany({ where: { userId: linked.id }, select: { channel: true, status: true } });
    expect(l1.map((r) => r.channel).sort()).toEqual(['chat', 'email', 'inApp']);
    expect(l1.find((r) => r.channel === 'chat')?.status).toBe('SENT');
    for (const other of [unlinked.id, unverified.id]) {
      const rows = await prisma.notificationDelivery.findMany({ where: { userId: other }, select: { channel: true } });
      expect(rows.map((r) => r.channel).sort(), other).toEqual(['email', 'inApp']);
    }
    expect((await prisma.chatIdentity.findFirst({ where: { userId: linked.id } }))?.dmChannelId).toBe(`D-U1${stamp}`);
    const sent = await prisma.chatDelivery.findMany({ where: { workspaceId: ws.id } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: 'SENT', eventKey: 'deadline.stagePassed', externalMessageId: 'ts-1', orgId: org.id });
    expect((await prisma.chatWorkspace.findUnique({ where: { id: ws.id } }))?.lastDeliveryAt).not.toBeNull();

    // 2. The kill switch: chat SKIPPED, the e-mail still queued.
    await prisma.chatWorkspace.update({ where: { id: ws.id }, data: { enabled: false } });
    const before2 = new Date(Date.now() - 1);
    await notifyEvent(linked.id, 'deadline.stagePassed', { menteeName: 'Berk', relationId: 'rel-2' }, { dedupeKey: `b-${stamp}` });
    expect(posts).toHaveLength(1);
    const l2 = await prisma.notificationDelivery.findMany({ where: { userId: linked.id, createdAt: { gte: before2 } }, select: { channel: true, status: true, skipReason: true } });
    expect(l2.find((r) => r.channel === 'chat')).toMatchObject({ status: 'SKIPPED', skipReason: 'workspace_disabled' });
    expect(l2.find((r) => r.channel === 'email')?.status).toBe('QUEUED');
    expect(l2.find((r) => r.channel === 'inApp')?.status).toBe('SENT');
    expect(await prisma.chatDelivery.count({ where: { workspaceId: ws.id, status: 'SKIPPED', error: 'workspace_disabled' } })).toBe(1);

    // 3. A platform refusal: FAILED with its code, nothing else touched.
    await prisma.chatWorkspace.update({ where: { id: ws.id }, data: { enabled: true } });
    setChatClientsForTests({ SLACK: recordingClient(posts, 'channel_not_found') });
    const r3 = await notifyEvent(linked.id, 'deadline.stagePassed', { menteeName: 'Cem', relationId: 'rel-3' }, { dedupeKey: `c-${stamp}` });
    expect(r3).toMatchObject({ sent: 1, queued: 1, failed: 1 });
    expect(await prisma.chatDelivery.count({ where: { workspaceId: ws.id, status: 'FAILED', error: 'channel_not_found' } })).toBe(1);
    expect((await prisma.chatWorkspace.findUnique({ where: { id: ws.id } }))?.lastError).toBe('channel_not_found');

    // 4. A caller that pins its channels (a security notice: in-app only) gets exactly those.
    const r4 = await notifyEvent(linked.id, 'deadline.stagePassed', { menteeName: 'Deniz', relationId: 'rel-4' }, { dedupeKey: `d-${stamp}`, channels: ['inApp'] });
    expect(r4).toMatchObject({ sent: 1, queued: 0, failed: 0 });
  } finally {
    const ids = [linked.id, unlinked.id, unverified.id, admin.id];
    await prisma.notificationDelivery.deleteMany({ where: { userId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.job.deleteMany({ where: { name: 'notification.email', idempotencyKey: { contains: stamp } } }).catch(() => undefined);
    await prisma.chatWorkspace.deleteMany({ where: { id: ws.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
  }
});

test('free core and one port: the chat path asks no plan, and no platform URL lives outside the client', { tag: '@smoke' }, () => {
  const root = path.resolve(__dirname, '..');
  const adapter = fs.readFileSync(path.join(root, 'src/lib/notifications/adapters/chat.ts'), 'utf8');
  for (const gate of ['entitled', 'planGate', 'entitlements', 'capabilityGate', 'requireCapability', 'subscription']) {
    expect(adapter, gate).not.toMatch(new RegExp(`from '@/lib/${gate}'|\\b${gate}\\(`));
  }
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(ent.name) && !p.includes(path.join('src', 'lib', 'chat', 'client'))) {
        const src = fs.readFileSync(p, 'utf8');
        if (/slack\.com\/api|botframework\.com|login\.microsoftonline\.com\/botframework/.test(src)) offenders.push(path.relative(root, p));
      }
    }
  };
  walk(path.join(root, 'src'));
  expect(offenders).toEqual([]);
});
