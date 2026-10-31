import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { slackSignatureFor } from '@/lib/chat/slackSignature';

// Booking from chat (#1951), over HTTP against the dev server, through the one
// interaction endpoint (#1948):
//
//  · "my next meetings" offers a mentee a Book button; Book offers the next
//    three times that work for both (the app's suggested-times answer);
//  · a pick opens a MeetingRequest through the app's own service — a second
//    click on the same time opens nothing new — and the mentor gets a chat
//    card for it;
//  · only the pair's mentor may answer: another mentor and the mentee
//    themselves get nothing; the mentor's Accept books a real Meeting (RSVP
//    token, the room) and a second Accept is "already answered";
//  · a request for an hour that was booked meanwhile is refused at accept time
//    ("no longer free"), not double-booked.

const SECRET = 'e2e-slack-signing-secret';
const PW = 'ChatBook123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

type Reply = { text?: string; replace_original?: boolean; blocks?: { type: string; elements?: { action_id?: string; value?: string; text?: { text: string } }[] }[] };
const buttonsOf = (r: Reply) => (r.blocks ?? []).flatMap((b) => b.elements ?? []).filter((e) => e.action_id);

test('book from chat: three real slots → a request → only the mentor accepts → one Meeting', async ({ playwright, baseURL }) => {
  test.setTimeout(240_000);
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `ChatBook ${stamp}`, slug: `chatbook-${stamp}` } });
  const emails = { mentor: uniqueEmail('cb-mentor'), mentee: uniqueEmail('cb-mentee'), other: uniqueEmail('cb-other') };
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'CB Mentor', { orgId: org.id });
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', 'CB Mentee', { orgId: org.id });
  const other = await seedUser(emails.other, PW, 'MENTOR', 'CB Other', { orgId: org.id });
  await prisma.user.update({ where: { id: mentor.id }, data: { timezone: 'Europe/Berlin' } });
  await prisma.user.update({ where: { id: mentee.id }, data: { timezone: 'Europe/Berlin' } });
  const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id } });
  // Office hours every day, so the next three free times always exist.
  await prisma.availabilitySlot.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ mentorId: mentor.id, weekday, startTime: '09:00', endTime: '17:00' })) });

  const team = `T${stamp}`;
  const ws = await prisma.chatWorkspace.create({
    data: { orgId: org.id, platform: 'SLACK', externalId: team, name: 'Acme Slack', scope: 'chat:write', installedById: mentor.id },
  });
  const ids = { mentee: `UME${stamp}`, mentor: `UMO${stamp}`, other: `UOT${stamp}` };
  await prisma.chatIdentity.createMany({
    data: [
      { orgId: org.id, workspaceId: ws.id, userId: mentee.id, externalUserId: ids.mentee, verifiedAt: new Date() },
      { orgId: org.id, workspaceId: ws.id, userId: mentor.id, externalUserId: ids.mentor, verifiedAt: new Date() },
      { orgId: org.id, workspaceId: ws.id, userId: other.id, externalUserId: ids.other, verifiedAt: new Date() },
    ],
  });

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

  // One click: post it signed, wait for the reply on the response_url. Like
  // Slack, every click carries its own action_ts — an identical body inside
  // the window is a replay and is refused (#1948).
  const click = async (user: string, actionId: string, value: string): Promise<Reply> => {
    const n = received.length;
    const body = new URLSearchParams({
      payload: JSON.stringify({ type: 'block_actions', team: { id: team }, user: { id: user }, actions: [{ action_id: actionId, value, action_ts: `${Date.now()}.${crypto.randomBytes(3).toString('hex')}` }], response_url: sinkUrl }),
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

  try {
    // "My next meetings" → nothing yet, and a Book button for this pair.
    const upcoming = await click(ids.mentee, 'meetings.upcoming', 'x');
    expect(buttonsOf(upcoming)).toEqual([expect.objectContaining({ action_id: 'meeting.book', value: relation.id })]);

    // Book → three times, each a pick for this relation.
    const offer = await click(ids.mentee, 'meeting.book', relation.id);
    const picks = buttonsOf(offer);
    expect(picks).toHaveLength(3);
    for (const p of picks) {
      expect(p.action_id).toBe('meeting.book.pick');
      expect(p.value?.startsWith(`${relation.id}|`)).toBe(true);
      expect(new Date(p.value!.split('|')[1]).getTime()).toBeGreaterThan(Date.now());
    }
    // Another mentor asking for this pair's times gets nothing.
    expect(buttonsOf(await click(ids.other, 'meeting.book', relation.id))).toHaveLength(0);

    // Pick → one MeetingRequest at that instant; a second click opens nothing new.
    const [, iso] = picks[0].value!.split('|');
    const picked = await click(ids.mentee, 'meeting.book.pick', picks[0].value!);
    expect(picked.replace_original).toBe(true);
    await click(ids.mentee, 'meeting.book.pick', picks[0].value!);
    const requests = await prisma.meetingRequest.findMany({ where: { relationId: relation.id } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ requestedById: mentee.id, status: 'PENDING' });
    expect(requests[0].proposedAt.toISOString()).toBe(new Date(iso).toISOString());
    const reqId = requests[0].id;

    // The mentor was told on chat too (the card with Accept/Decline).
    const mentorIdentity = await prisma.chatIdentity.findFirstOrThrow({ where: { workspaceId: ws.id, userId: mentor.id } });
    await expect
      .poll(() => prisma.chatDelivery.count({ where: { identityId: mentorIdentity.id, eventKey: 'meeting_request.new', subjectKey: `meeting-request:${reqId}` } }), { timeout: 30_000 })
      .toBe(1);

    // Neither another mentor nor the mentee can answer it.
    await click(ids.other, 'meeting_request.accept', reqId);
    await click(ids.mentee, 'meeting_request.accept', reqId);
    expect((await prisma.meetingRequest.findUniqueOrThrow({ where: { id: reqId } })).status).toBe('PENDING');
    expect(await prisma.meeting.count({ where: { relationId: relation.id } })).toBe(0);

    // The mentor accepts on the card → one real Meeting, the card replaced.
    const accepted = await click(ids.mentor, 'meeting_request.accept', reqId);
    expect(accepted.replace_original).toBe(true);
    const meetings = await prisma.meeting.findMany({ where: { relationId: relation.id } });
    expect(meetings).toHaveLength(1);
    expect(meetings[0].scheduledAt?.toISOString()).toBe(new Date(iso).toISOString());
    expect(meetings[0].rsvpToken).toBeTruthy();
    expect(meetings[0].createdById).toBe(mentor.id);
    expect((await prisma.meetingRequest.findUniqueOrThrow({ where: { id: reqId } })).status).toBe('ACCEPTED');

    // A second Accept is "already answered", and books nothing.
    await click(ids.mentor, 'meeting_request.accept', reqId);
    expect(await prisma.meeting.count({ where: { relationId: relation.id } })).toBe(1);

    // A request for the hour that is now booked is refused at accept time.
    const stale = await prisma.meetingRequest.create({ data: { relationId: relation.id, requestedById: mentee.id, topic: 'Same hour', proposedAt: new Date(iso) } });
    await click(ids.mentor, 'meeting_request.accept', stale.id);
    expect((await prisma.meetingRequest.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('PENDING');
    expect(await prisma.meeting.count({ where: { relationId: relation.id } })).toBe(1);
  } finally {
    await api.dispose();
    await new Promise((r) => sink.close(r));
    await prisma.chatDelivery.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.chatIdentity.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.chatWorkspace.deleteMany({ where: { id: ws.id } });
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await prisma.meetingRequest.deleteMany({ where: { relationId: relation.id } });
    await prisma.availabilitySlot.deleteMany({ where: { mentorId: mentor.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
