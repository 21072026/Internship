import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { slackSignatureFor } from '@/lib/chat/slackSignature';
import { setChatClientsForTests, type ChatPlatformClient, type CardButton } from '@/lib/chat/client';
import { sealBotToken } from '@/lib/chat/tokens';
import { logEndedMeetingInteractions } from '@/lib/meetingAutoLog';

// Notes from the post-meeting card (#1953). The auto-log is run in process
// with a RECORDING Slack client; the clicks go over HTTP through the one
// interaction endpoint:
//
//  · a meeting that took place is logged once, and its mentor gets ONE card
//    whose "Add notes" names that log row — logging it again posts nothing;
//  · "Add notes" asks for the text in a field; the typed note is written into
//    the SAME row through the app's edit path — no second log for the session;
//  · another mentor can neither open the field nor write the row; an empty
//    note writes nothing.

const SECRET = 'e2e-slack-signing-secret';
const PW = 'ChatMeetLog123!';

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

type Reply = { text?: string; replace_original?: boolean; blocks?: { type: string; block_id?: string; element?: { action_id?: string } }[] };

test.beforeAll(() => {
  process.env.CHAT_APPS_ENABLED = '1';
  process.env.NEXTAUTH_SECRET ||= 'unit-test-secret-not-for-production';
});

test.afterAll(async () => {
  setChatClientsForTests({});
  delete process.env.CHAT_APPS_ENABLED;
  await prisma.$disconnect();
});

test('post-meeting card: notes land in the meeting’s own log row, through the edit path', async ({ playwright, baseURL }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `MeetLog ${stamp}`, slug: `meetlog-${stamp}` } });
  const emails = { mentor: uniqueEmail('ml-mentor'), mentee: uniqueEmail('ml-mentee'), other: uniqueEmail('ml-other') };
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'ML Mentor', { orgId: org.id });
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', 'ML Mentee', { orgId: org.id });
  const other = await seedUser(emails.other, PW, 'MENTOR', 'ML Other', { orgId: org.id });
  const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id } });
  const title = `CV review ${stamp}`;
  const meeting = await prisma.meeting.create({
    data: {
      relationId: relation.id,
      title,
      scheduledAt: new Date(Date.now() - 3 * 3600_000),
      createdById: mentor.id,
      meetLink: `https://meet.example.test/${stamp}`,
      rsvpToken: crypto.randomBytes(16).toString('hex'),
    },
  });

  const team = `T${stamp}`;
  const ws = await prisma.chatWorkspace.create({
    data: { orgId: org.id, platform: 'SLACK', externalId: team, name: 'Acme Slack', scope: 'chat:write,im:write', botTokenEnc: sealBotToken('xoxb-synthetic'), installedById: mentor.id },
  });
  const ids = { mentor: `UMO${stamp}`, other: `UOT${stamp}` };
  await prisma.chatIdentity.createMany({
    data: [
      { orgId: org.id, workspaceId: ws.id, userId: mentor.id, externalUserId: ids.mentor, verifiedAt: new Date() },
      { orgId: org.id, workspaceId: ws.id, userId: other.id, externalUserId: ids.other, verifiedAt: new Date() },
    ],
  });
  const posts: Post[] = [];
  setChatClientsForTests({ SLACK: recordingClient(posts) });

  const received: Reply[] = [];
  const sink = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push({});
      }
      res.end('ok');
    });
  });
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
  const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;
  const api = await playwright.request.newContext({ baseURL });

  const send = async (user: string, action: Record<string, unknown>): Promise<Reply> => {
    const n = received.length;
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: team },
        user: { id: user },
        actions: [{ ...action, action_ts: `${Date.now()}.${crypto.randomBytes(3).toString('hex')}` }],
        response_url: sinkUrl,
      }),
    }).toString();
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await api.post('/api/integrations/chat/slack/interactions', {
      data: body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignatureFor(SECRET, ts, body) },
      timeout: 60_000,
    });
    expect(res.status()).toBe(200);
    await expect.poll(() => received.length, { timeout: 60_000 }).toBeGreaterThan(n);
    return received[n];
  };
  const click = (user: string, value: string) => send(user, { action_id: 'interaction.note', value });
  const type = (user: string, rowId: string, text: string) =>
    send(user, { type: 'plain_text_input', action_id: 'interaction.note.save', block_id: rowId, value: text });
  const fieldOf = (r: Reply) => (r.blocks ?? []).find((b) => b.type === 'input');

  try {
    // The meeting is over: one log row, one card to its mentor naming that row.
    expect(await logEndedMeetingInteractions(meeting.id)).toBe(1);
    const row = await prisma.interactionLog.findUniqueOrThrow({ where: { meetingId: meeting.id } });
    const placeholder = row.notes;
    const mine = posts.filter((p) => p.target === `D-${ids.mentor}`);
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toContain(title);
    expect(mine[0].buttons).toEqual([expect.objectContaining({ actionId: 'interaction.note', value: row.id })]);
    // Logged once: a second end click posts no second card.
    expect(await logEndedMeetingInteractions(meeting.id)).toBe(0);
    expect(posts.filter((p) => p.target === `D-${ids.mentor}`)).toHaveLength(1);
    expect(posts.filter((p) => p.target === `D-${ids.other}`)).toHaveLength(0);

    // Another mentor: no field, and typing into a forged one writes nothing.
    expect(fieldOf(await click(ids.other, row.id))).toBeUndefined();
    await type(ids.other, row.id, 'Not my mentee');
    expect((await prisma.interactionLog.findUniqueOrThrow({ where: { id: row.id } })).notes).toBe(placeholder);

    // The mentor: the field names the row; an empty note writes nothing.
    const field = fieldOf(await click(ids.mentor, row.id));
    expect(field).toMatchObject({ block_id: row.id, element: { action_id: 'interaction.note.save' } });
    await type(ids.mentor, row.id, '   ');
    expect((await prisma.interactionLog.findUniqueOrThrow({ where: { id: row.id } })).notes).toBe(placeholder);

    // The typed note replaces the placeholder in the same row — no second log.
    const saved = await type(ids.mentor, row.id, 'Went through the CV; next: two applications.');
    expect(saved.replace_original).toBe(true);
    const after = await prisma.interactionLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ notes: 'Went through the CV; next: two applications.', type: 'Meeting', meetingId: meeting.id, relationId: relation.id });
    expect(await prisma.interactionLog.count({ where: { relationId: relation.id } })).toBe(1);
  } finally {
    await api.dispose();
    await new Promise((r) => sink.close(r));
    await prisma.chatDelivery.deleteMany({ where: { workspaceId: ws.id } }).catch(() => {});
    await prisma.chatIdentity.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.chatWorkspace.deleteMany({ where: { id: ws.id } });
    await prisma.interactionLog.deleteMany({ where: { relationId: relation.id } });
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
