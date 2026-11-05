import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { setChatClientsForTests, type ChatPlatformClient, type CardButton } from '@/lib/chat/client';
import { sealBotToken } from '@/lib/chat/tokens';
import { introducePairInChat } from '@/lib/chat/pairingInChat';
import { emailGroupPrefKey } from '@/lib/emailGroups';

// The pairing DM (#1946), in process with a RECORDING Slack client: both sides
// of a new pair get ONE card each, in their own language — the mentee with a
// Book button for this relation, the mentor with the mentee's top skills —
// and a side who switched the pairing mail off gets no card either.

const PW = 'PairingDm123!';
type Post = { target: string; text: string; buttons: CardButton[] };

function recordingClient(posts: Post[]): ChatPlatformClient {
  return {
    async postMessage({ target, text, buttons }) {
      posts.push({ target: target.id, text, buttons: buttons ?? [] });
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

test('a new pair gets one introduction card per side, in their language, opt-out honoured', async () => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Pairing ${stamp}`, slug: `pairing-${stamp}` } });
  const emails = { mentor: uniqueEmail('pd-mentor'), mentee: uniqueEmail('pd-mentee'), mentor2: uniqueEmail('pd-mentor2'), mentee2: uniqueEmail('pd-mentee2') };
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', `PD Mentor ${stamp}`, { orgId: org.id });
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', `PD Mentee ${stamp}`, { orgId: org.id });
  await prisma.user.update({ where: { id: mentor.id }, data: { preferredLanguage: 'de' } });
  await prisma.user.update({ where: { id: mentee.id }, data: { skills: ['TypeScript', 'SQL', 'Figma', 'Excel'], phone: '+49 30 1234567' } });
  const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id } });

  const ws = await prisma.chatWorkspace.create({
    data: { orgId: org.id, platform: 'SLACK', externalId: `T${stamp}`, name: 'Acme Slack', scope: 'chat:write,im:write', botTokenEnc: sealBotToken('xoxb-synthetic'), installedById: mentor.id },
  });
  const link = (userId: string, ext: string) => prisma.chatIdentity.create({ data: { orgId: org.id, workspaceId: ws.id, userId, externalUserId: ext, verifiedAt: new Date() } });
  await link(mentor.id, `UMO${stamp}`);
  await link(mentee.id, `UME${stamp}`);
  const posts: Post[] = [];
  setChatClientsForTests({ SLACK: recordingClient(posts) });
  const to = (ext: string) => posts.filter((p) => p.target === `D-${ext}`);
  const side = (u: { id: string }) => prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { id: true, fullName: true, emailNotifications: true, notificationPrefs: true } });

  // A second pair whose mentor switched the pairing mail off.
  const mentor2 = await seedUser(emails.mentor2, PW, 'MENTOR', 'PD Quiet Mentor', { orgId: org.id });
  const mentee2 = await seedUser(emails.mentee2, PW, 'MENTEE', 'PD Mentee Two', { orgId: org.id });
  await prisma.user.update({ where: { id: mentor2.id }, data: { notificationPrefs: { [emailGroupPrefKey('mentorship_lifecycle')]: false } } });
  const relation2 = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor2.id, menteeId: mentee2.id } });
  await link(mentor2.id, `UQ${stamp}`);

  try {
    await introducePairInChat(relation.id, await side(mentor), await side(mentee));
    // A retried announcement posts nothing twice.
    await introducePairInChat(relation.id, await side(mentor), await side(mentee));

    const menteeCards = to(`UME${stamp}`);
    expect(menteeCards).toHaveLength(1);
    expect(menteeCards[0].text).toContain(`PD Mentor ${stamp}`);
    expect(menteeCards[0].buttons).toEqual([expect.objectContaining({ actionId: 'meeting.book', value: relation.id })]);

    const mentorCards = to(`UMO${stamp}`);
    expect(mentorCards).toHaveLength(1);
    // German, the mentor's language; the top three skills and nothing else of the profile.
    expect(mentorCards[0].text).toContain('gepaart');
    expect(mentorCards[0].text).toContain('TypeScript, SQL, Figma');
    expect(mentorCards[0].text).not.toContain('Excel');
    expect(mentorCards[0].text).not.toContain('1234567');

    await introducePairInChat(relation2.id, await side(mentor2), await side(mentee2));
    expect(to(`UQ${stamp}`)).toHaveLength(0);
  } finally {
    await prisma.notificationDelivery.deleteMany({ where: { userId: { in: [mentor.id, mentee.id, mentor2.id, mentee2.id] } } });
    await prisma.chatDelivery.deleteMany({ where: { workspaceId: ws.id } }).catch(() => {});
    await prisma.chatIdentity.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.chatWorkspace.deleteMany({ where: { id: ws.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
