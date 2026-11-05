import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { setChatClientsForTests, type ChatPlatformClient } from '@/lib/chat/client';
import { sealBotToken } from '@/lib/chat/tokens';
import { sweepDormantFirstContacts } from '../src/lib/dormantFirstContact';
import { sendDormantCheckIns, DORMANT_MAX_NUDGES } from '../src/services/emailService';

// The two-nudge cap across channels (#1946, docs/dormant-first-contacts.md):
// chat is a CHANNEL for the "still interested?" check-in, never a third
// message. In process, against a real database, with a recording Slack client:
//
//  · linked on chat: the nudge goes as a card and NOT as a mail;
//  · unlinked before the second nudge: the second goes as a mail;
//  · relinked: nothing more, ever — mail + chat together = DORMANT_MAX_NUDGES;
//  · a card that cannot be posted falls back to the mail: one claim, one message;
//  · no nudge moves a stage or closes the pair.

const DAY = 24 * 60 * 60 * 1000;
const PW = 'DormantChat123!';
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function client(posts: string[], fail = false): ChatPlatformClient {
  return {
    async postMessage({ target, text }) {
      if (fail) throw new Error('platform down');
      posts.push(`${target.id}|${text}`);
      return { externalMessageId: `ts-${posts.length}` };
    },
    async updateMessage() {},
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

async function dormantPair(stamp: string) {
  const org = await prisma.organization.create({ data: { name: `Dormant ${stamp}`, slug: `dormant-${stamp}` } });
  const emails = { mentor: uniqueEmail('dc-mentor'), mentee: uniqueEmail('dc-mentee') };
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'DC Mentor', { orgId: org.id });
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', 'DC Mentee', { orgId: org.id });
  const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' } });
  await prisma.interactionLog.create({ data: { relationId: relation.id, date: daysAgo(60), notes: 'Welcome', type: 'Email' } });
  await sweepDormantFirstContacts();
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).dormantSince).not.toBeNull();
  const ws = await prisma.chatWorkspace.create({
    data: { orgId: org.id, platform: 'SLACK', externalId: `T${stamp}`, name: 'Acme Slack', scope: 'chat:write,im:write', botTokenEnc: sealBotToken('xoxb-synthetic'), installedById: mentor.id },
  });
  const link = () => prisma.chatIdentity.create({ data: { orgId: org.id, workspaceId: ws.id, userId: mentee.id, externalUserId: `UE${stamp}`, verifiedAt: new Date() } });
  const unlink = () => prisma.chatIdentity.deleteMany({ where: { workspaceId: ws.id, userId: mentee.id } });
  const mails = () => prisma.emailLog.count({ where: { to: emails.mentee, category: 'dormant-check-in' } });
  const cleanup = async () => {
    await prisma.notificationDelivery.deleteMany({ where: { userId: mentee.id } });
    await prisma.chatDelivery.deleteMany({ where: { workspaceId: ws.id } }).catch(() => {});
    await unlink();
    await prisma.chatWorkspace.deleteMany({ where: { id: ws.id } });
    await prisma.emailLog.deleteMany({ where: { to: emails.mentee } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } });
  };
  return { relation, link, unlink, mails, cleanup, dm: `D-UE${stamp}` };
}

test('mail + chat together never exceed the two-nudge cap', async () => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const pair = await dormantPair(stamp);
  const posts: string[] = [];
  setChatClientsForTests({ SLACK: client(posts) });
  const cards = () => posts.filter((p) => p.startsWith(`${pair.dm}|`)).length;
  try {
    // Linked: the first nudge is a card, and no mail.
    await pair.link();
    await sendDormantCheckIns();
    expect(cards()).toBe(1);
    expect(await pair.mails()).toBe(0);

    // Unlinked a month later: the second (final) nudge is a mail.
    await pair.unlink();
    await sendDormantCheckIns(new Date(Date.now() + 32 * DAY));
    expect(cards()).toBe(1);
    expect(await pair.mails()).toBe(1);

    // Relinked, and much later: nothing more on any channel.
    await pair.link();
    await sendDormantCheckIns(new Date(Date.now() + 400 * DAY));
    await sendDormantCheckIns(new Date(Date.now() + 800 * DAY));
    expect(cards() + (await pair.mails())).toBe(DORMANT_MAX_NUDGES);

    const row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: pair.relation.id } });
    // One counter for both channels; and nothing moved the pair.
    expect(row).toMatchObject({ dormantNudgeCount: DORMANT_MAX_NUDGES, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' });
  } finally {
    await pair.cleanup();
  }
});

test('a card that cannot be posted falls back to the mail — one claim, one message', async () => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const pair = await dormantPair(stamp);
  const posts: string[] = [];
  setChatClientsForTests({ SLACK: client(posts, true) });
  try {
    await pair.link();
    await sendDormantCheckIns();
    expect(posts).toHaveLength(0);
    expect(await pair.mails()).toBe(1);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: pair.relation.id } })).dormantNudgeCount).toBe(1);
  } finally {
    await pair.cleanup();
  }
});
