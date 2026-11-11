import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { setChatClientsForTests, type ChatPlatformClient, type CardAction } from '@/lib/chat/client';
import { sealBotToken } from '@/lib/chat/tokens';
import { sendMeetingReminders } from '@/services/emailService';
import { noticeMeetingsCancelled } from '@/lib/meetingChangeNotices';

// Meeting events in chat (#1942), in-process against a real database with a
// RECORDING Slack client:
//
//  · the reminder tick posts exactly ONE card per meeting for a linked person —
//    `reminderSentAt` is the single-shot guard for every channel together — with
//    the join link as a button and the time on the RECIPIENT's clock;
//  · a meeting with no time gets no reminder on any channel;
//  · cancelling rewrites that card in place (chat.update) with no button, so
//    nothing left in the DM still says "join".

const PW = 'MeetingChat123!';

type Post = { target: string; text: string; action: CardAction | null };
type Update = { target: string; externalMessageId: string; text: string; action: CardAction | null };

function recordingClient(posts: Post[], updates: Update[]): ChatPlatformClient {
  return {
    async postMessage({ target, text, action }) {
      posts.push({ target: target.id, text, action: action ?? null });
      return { externalMessageId: `ts-${posts.length}` };
    },
    async updateMessage({ target, externalMessageId, text, action }) {
      updates.push({ target: target.id, externalMessageId, text, action: action ?? null });
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

test('schedule → one reminder card with a join button on the recipient clock → cancel supersedes it', async () => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `MeetChat Org ${stamp}`, slug: `meetchat-${stamp}` } });
  const emails = { mentor: uniqueEmail('mc-mentor'), mentee: uniqueEmail('mc-mentee') };
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'MC Mentor', { orgId: org.id });
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', 'MC Mentee', { orgId: org.id });
  // The mentee reads time in Tokyo; the meeting was set on a Berlin clock.
  await prisma.user.update({ where: { id: mentee.id }, data: { timezone: 'Asia/Tokyo' } });
  const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id } });
  const ws = await prisma.chatWorkspace.create({
    data: {
      orgId: org.id, platform: 'SLACK', externalId: `T${stamp}`, name: 'Acme Slack', scope: 'chat:write,im:write',
      botTokenEnc: sealBotToken('xoxb-synthetic'), installedById: mentor.id,
    },
  });
  await prisma.chatIdentity.create({ data: { orgId: org.id, workspaceId: ws.id, userId: mentee.id, externalUserId: `U${stamp}`, verifiedAt: new Date() } });
  const posts: Post[] = [];
  const updates: Update[] = [];
  setChatClientsForTests({ SLACK: recordingClient(posts, updates) });

  const at = new Date(Date.now() + 20 * 60_000);
  at.setUTCSeconds(0, 0);
  const title = `Chat Reminder ${stamp}`;
  const meeting = await prisma.meeting.create({
    data: {
      relationId: relation.id, title, scheduledAt: at, timeZone: 'Europe/Berlin', meetLink: 'https://meet.example.test/room-1',
      rsvpToken: crypto.randomBytes(24).toString('hex'), createdById: mentor.id,
    },
  });
  // A time-less meeting is "just a shared link": no reminder, on any channel.
  const timeless = await prisma.meeting.create({
    data: { relationId: relation.id, title: `Chat Timeless ${stamp}`, rsvpToken: crypto.randomBytes(24).toString('hex'), createdById: mentor.id },
  });

  try {
    await sendMeetingReminders();
    await sendMeetingReminders(); // a second tick sends nothing more
    const mine = posts.filter((p) => p.target === `D-U${stamp}`);
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toContain(title);
    expect(mine[0].action).toEqual({ label: 'Join the meeting', url: 'https://meet.example.test/room-1' });
    // The recipient's zone, never the organiser's: the Tokyo reading of the start.
    const tokyo = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
    expect(mine[0].text).toContain(tokyo);
    expect(posts.some((p) => p.text.includes(`Chat Timeless ${stamp}`))).toBe(false);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).reminderSentAt).not.toBeNull();
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: timeless.id } })).reminderSentAt).toBeNull();
    const reminderCard = await prisma.chatDelivery.findFirstOrThrow({ where: { workspaceId: ws.id, eventKey: 'meeting_reminder.startingSoon' } });
    expect(reminderCard).toMatchObject({ status: 'SENT', subjectKey: `meeting:${meeting.id}`, externalMessageId: 'ts-1', supersededAt: null });

    // Cancel: the card is rewritten in place, without a button — no second card.
    await prisma.meeting.update({ where: { id: meeting.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: mentor.id } });
    await noticeMeetingsCancelled([meeting.id], mentor.id, null);
    expect(posts.filter((p) => p.target === `D-U${stamp}`)).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ target: `D-U${stamp}`, externalMessageId: 'ts-1', action: null });
    expect(updates[0].text).toContain(title);
    expect((await prisma.chatDelivery.findUniqueOrThrow({ where: { id: reminderCard.id } })).supersededAt).not.toBeNull();
    const cancelRow = await prisma.chatDelivery.findFirstOrThrow({ where: { workspaceId: ws.id, eventKey: 'meeting.cancelled' } });
    expect(cancelRow).toMatchObject({ status: 'SENT', subjectKey: `meeting:${meeting.id}`, externalMessageId: 'ts-1' });
  } finally {
    const ids = [mentor.id, mentee.id];
    await prisma.notificationDelivery.deleteMany({ where: { userId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await prisma.chatWorkspace.deleteMany({ where: { id: ws.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
  }
});
