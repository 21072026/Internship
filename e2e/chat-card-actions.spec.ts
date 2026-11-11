import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { slackSignatureFor } from '@/lib/chat/slackSignature';

// Answering on the card (#1949), over HTTP against the app, through the one
// interaction endpoint (#1948):
//
//  · the invitee's Yes/No writes the same `Meeting.rsvp` the token page
//    writes (recordMeetingRsvp), replaces the card, and a second click writes
//    nothing and tells the organiser nothing twice; nobody else can answer;
//  · a mentor's Approve/Decline go through decideInterviewRequest(): another
//    mentor changes nothing, Decline asks for a reason first and writes only
//    when one is picked, and a decided request answers "already decided".

const SECRET = 'e2e-slack-signing-secret';
const PW = 'ChatCardAct123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

type Reply = { text?: string; replace_original?: boolean; blocks?: { elements?: { action_id?: string; value?: string }[] }[] };
const buttonsOf = (r: Reply) => (r.blocks ?? []).flatMap((b) => b.elements ?? []).filter((e) => e.action_id);

test('card answers: RSVP and interview decisions through the shared services, once', async ({ playwright, baseURL }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `CardAct ${stamp}`, slug: `cardact-${stamp}` } });
  const emails = { mentor: uniqueEmail('ca-mentor'), mentee: uniqueEmail('ca-mentee'), other: uniqueEmail('ca-other') };
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'CA Mentor', { orgId: org.id });
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', 'CA Mentee', { orgId: org.id });
  const other = await seedUser(emails.other, PW, 'MENTOR', 'CA Other', { orgId: org.id });
  const company = await prisma.company.create({ data: { name: `Acme Hiring ${stamp}`, orgId: org.id } });
  const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, companyId: company.id } });
  const requisition = await prisma.requisition.create({ data: { orgId: org.id, companyId: company.id, title: 'Junior Engineer', openings: 1 } });
  const meeting = await prisma.meeting.create({
    data: { relationId: relation.id, title: `Card RSVP ${stamp}`, scheduledAt: new Date(Date.now() + 2 * 24 * 3600_000), createdById: mentor.id, rsvpToken: crypto.randomBytes(16).toString('hex') },
  });
  const interview = await prisma.interviewRequest.create({ data: { orgId: org.id, requisitionId: requisition.id, menteeId: mentee.id, companyId: company.id } });

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

  // One click, signed like Slack signs it (every click carries its own action_ts).
  const click = async (user: string, actionId: string, value: string): Promise<Reply> => {
    const n = received.length;
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: team },
        user: { id: user },
        actions: [{ action_id: actionId, value, action_ts: `${Date.now()}.${crypto.randomBytes(3).toString('hex')}` }],
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
  const rsvpOf = async () => (await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).rsvp;
  const organiserTold = (type: string) => prisma.notification.count({ where: { userId: mentor.id, type } });

  try {
    // RSVP — only the invitee answers.
    expect(await rsvpOf()).toBe('PENDING');
    const notMine = await click(ids.other, 'meeting.rsvp.no', meeting.id);
    expect(notMine.replace_original).toBeFalsy();
    expect(await rsvpOf()).toBe('PENDING');

    const yes = await click(ids.mentee, 'meeting.rsvp.yes', meeting.id);
    expect(yes.replace_original).toBe(true);
    expect(await rsvpOf()).toBe('ACCEPTED');
    expect(await organiserTold('rsvp.accepted')).toBe(1);
    // A stale card clicked again: the same answer writes and tells nothing twice.
    await click(ids.mentee, 'meeting.rsvp.yes', meeting.id);
    expect(await organiserTold('rsvp.accepted')).toBe(1);
    // Changing the answer is a real write.
    await click(ids.mentee, 'meeting.rsvp.no', meeting.id);
    expect(await rsvpOf()).toBe('DECLINED');
    expect(await organiserTold('rsvp.declined')).toBe(1);

    // Interview — another mentor decides nothing.
    const status = async () => (await prisma.interviewRequest.findUniqueOrThrow({ where: { id: interview.id } })).status;
    const refused = await click(ids.other, 'interview_request.approve', interview.id);
    expect(refused.replace_original).toBeFalsy();
    expect(await status()).toBe('PENDING');

    // Decline asks for a reason first and writes nothing yet.
    const reasons = buttonsOf(await click(ids.mentor, 'interview_request.decline', interview.id));
    expect(reasons.map((b) => b.value)).toContain(`${interview.id}|NO_CONSENT`);
    expect(reasons.every((b) => b.action_id === 'interview_request.decline.reason')).toBe(true);
    expect(await status()).toBe('PENDING');

    const declined = await click(ids.mentor, 'interview_request.decline.reason', `${interview.id}|NO_CONSENT`);
    expect(declined.replace_original).toBe(true);
    const row = await prisma.interviewRequest.findUniqueOrThrow({ where: { id: interview.id } });
    expect(row).toMatchObject({ status: 'DECLINED', declineReasonCode: 'NO_CONSENT', decidedById: mentor.id });

    // A decided request: the card is replaced, nothing changes.
    const again = await click(ids.mentor, 'interview_request.approve', interview.id);
    expect(again.replace_original).toBe(true);
    expect(await status()).toBe('DECLINED');

    // Approve on a fresh request.
    await prisma.interviewRequest.update({ where: { id: interview.id }, data: { activeKey: null } });
    const second = await prisma.interviewRequest.create({ data: { orgId: org.id, requisitionId: requisition.id, menteeId: mentee.id, companyId: company.id } });
    await click(ids.mentor, 'interview_request.approve', second.id);
    expect((await prisma.interviewRequest.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('APPROVED');
  } finally {
    await api.dispose();
    await new Promise((r) => sink.close(r));
    await prisma.chatIdentity.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.chatWorkspace.deleteMany({ where: { id: ws.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
    await prisma.interviewRequest.deleteMany({ where: { orgId: org.id } });
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await prisma.requisition.deleteMany({ where: { orgId: org.id } });
    await prisma.company.deleteMany({ where: { id: company.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
