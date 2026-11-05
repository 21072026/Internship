import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { setChatClientsForTests, type ChatPlatformClient } from '@/lib/chat/client';
import { sealBotToken } from '@/lib/chat/tokens';
import { notifyEvent } from '@/lib/notifications/router';
import { slackSignatureFor } from '@/lib/chat/slackSignature';
import { notifyOfferDecided, notifyOfferSent } from '@/lib/offerNotify';
import { eventDef } from '@/lib/notifications/catalog';

// Hiring-loop events on chat (#1944). Everyone in the org has a confirmed chat
// identity, so a card that reaches the wrong person would be posted. The
// router and offer paths run in process with a RECORDING Slack client; the
// interview decision goes through the app (the mentor's Decline on the card,
// #1949), whose stub client leaves a ChatDelivery row per card:
//
//  · an internal approval event addressed to a mentee is refused by the
//    catalogue's audience — no card, no bell, a SKIPPED `not_audience` row;
//  · a declined interview request reaches the company's users (the reason
//    code only) and nobody else;
//  · an offer sent reaches the mentee only; an offer answered reaches the
//    admin who made it, deep-linked to the candidate, and nobody else;
//  · the bell rows these events wrote before are still written.

const PW = 'ChatHiring123!';
const SECRET = 'e2e-slack-signing-secret';

type Post = { target: string; text: string };

function recordingClient(posts: Post[]): ChatPlatformClient {
  return {
    async postMessage({ target, text }) {
      posts.push({ target: target.id, text });
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

test('every hiring event declares its audience; no internal approval event lists a mentee or a company', { tag: '@smoke' }, () => {
  const audience = (key: string) => eventDef(key)?.audience ?? null;
  for (const key of ['interview_request.received', 'interview.panelComplete', 'offer_accepted.admin', 'offer_declined.admin', 'offer_expired.admin']) {
    expect(audience(key), key).not.toBeNull();
    expect(audience(key), key).not.toContain('MENTEE');
    expect(audience(key), key).not.toContain('COMPANY');
  }
  expect(audience('interview_request.declined')).toEqual(['COMPANY']);
  expect(audience('interview_request.approved')).toEqual(['MENTEE']);
  expect(audience('offer_sent.new')).toEqual(['MENTEE']);
  for (const d of ['advance', 'offer', 'reject']) expect(audience(`interview_panel.outcome.${d}`)).toEqual(['COMPANY']);
});

test('hiring cards reach exactly their entitled recipient', async ({ playwright, baseURL }) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Hiring Chat ${stamp}`, slug: `hiring-chat-${stamp}` } });
  const company = await prisma.company.create({ data: { name: `Acme Hiring ${stamp}`, orgId: org.id } });
  const emails = { admin: uniqueEmail('hc-admin'), mentor: uniqueEmail('hc-mentor'), mentee: uniqueEmail('hc-mentee'), company: uniqueEmail('hc-company') };
  const admin = await seedUser(emails.admin, PW, 'ADMIN', 'HC Admin', { orgId: org.id });
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'HC Mentor', { orgId: org.id });
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', `HC Candidate ${stamp}`, { orgId: org.id });
  const companyUser = await seedUser(emails.company, PW, 'COMPANY', 'HC Recruiter', { orgId: org.id });
  await prisma.user.updateMany({ where: { id: { in: [admin.id, mentee.id, companyUser.id] } }, data: { emailNotifications: false } });
  await prisma.user.update({ where: { id: companyUser.id }, data: { companyId: company.id } });
  const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, companyId: company.id } });
  const requisition = await prisma.requisition.create({ data: { orgId: org.id, companyId: company.id, title: `Junior Engineer ${stamp}`, openings: 1 } });
  const interview = await prisma.interviewRequest.create({ data: { orgId: org.id, requisitionId: requisition.id, menteeId: mentee.id, companyId: company.id } });

  const ws = await prisma.chatWorkspace.create({
    data: { orgId: org.id, platform: 'SLACK', externalId: `T${stamp}`, name: 'Acme Slack', scope: 'chat:write,im:write', botTokenEnc: sealBotToken('xoxb-synthetic'), installedById: admin.id },
  });
  const dm = { admin: `D-UA${stamp}`, mentor: `D-UM${stamp}`, mentee: `D-UE${stamp}`, company: `D-UC${stamp}` };
  await prisma.chatIdentity.createMany({
    data: [
      { orgId: org.id, workspaceId: ws.id, userId: admin.id, externalUserId: `UA${stamp}`, verifiedAt: new Date() },
      { orgId: org.id, workspaceId: ws.id, userId: mentor.id, externalUserId: `UM${stamp}`, verifiedAt: new Date() },
      { orgId: org.id, workspaceId: ws.id, userId: mentee.id, externalUserId: `UE${stamp}`, verifiedAt: new Date() },
      { orgId: org.id, workspaceId: ws.id, userId: companyUser.id, externalUserId: `UC${stamp}`, verifiedAt: new Date() },
    ],
  });
  const posts: Post[] = [];
  setChatClientsForTests({ SLACK: recordingClient(posts) });
  const to = (target: string) => posts.filter((p) => p.target === target);
  const identityOf = async (userId: string) => (await prisma.chatIdentity.findFirstOrThrow({ where: { workspaceId: ws.id, userId } })).id;

  const sink = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
  const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;
  const api = await playwright.request.newContext({ baseURL });
  const click = async (user: string, actionId: string, value: string) => {
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: `T${stamp}` },
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
  };

  try {
    // An internal approval event addressed to the candidate: refused, on every channel.
    await notifyEvent(mentee.id, 'interview_request.received', { menteeName: 'HC Candidate' });
    expect(to(dm.mentee)).toHaveLength(0);
    expect(await prisma.notification.count({ where: { userId: mentee.id, type: 'interview_request.received' } })).toBe(0);
    const refused = await prisma.notificationDelivery.findMany({ where: { userId: mentee.id, eventKey: 'interview_request.received' }, select: { status: true, skipReason: true } });
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((r) => r.status === 'SKIPPED' && r.skipReason === 'not_audience')).toBe(true);

    // Declined by the mentor on the card: the company's users get a card, the mentee none.
    await click(`UM${stamp}`, 'interview_request.decline.reason', `${interview.id}|NO_CONSENT`);
    await expect.poll(async () => (await prisma.interviewRequest.findUniqueOrThrow({ where: { id: interview.id } })).status, { timeout: 60_000 }).toBe('DECLINED');
    const companyIdentity = await identityOf(companyUser.id);
    await expect
      .poll(() => prisma.chatDelivery.count({ where: { identityId: companyIdentity, eventKey: 'interview_request.declined', status: 'SENT' } }), { timeout: 60_000 })
      .toBe(1);
    expect(await prisma.chatDelivery.count({ where: { identityId: await identityOf(mentee.id), eventKey: 'interview_request.declined' } })).toBe(0);
    // The bell row the company always got is still written.
    expect(await prisma.notification.count({ where: { userId: companyUser.id, type: 'interview_request.declined' } })).toBe(1);

    // An offer: sent → the candidate; answered → its creator, linked to the candidate.
    const offer = await prisma.offer.create({ data: { orgId: org.id, relationId: relation.id, companyId: company.id, position: `Engineer ${stamp}`, createdById: admin.id, status: 'SENT', sentAt: new Date() } });
    await notifyOfferSent(offer.id);
    expect(to(dm.mentee)).toHaveLength(1);
    expect(to(dm.mentee)[0].text).toContain(`Engineer ${stamp}`);
    await notifyOfferDecided(offer.id, 'ACCEPTED');
    expect(to(dm.admin)).toHaveLength(1);
    expect(to(dm.admin)[0].text).toContain(`HC Candidate ${stamp}`);
    expect(to(dm.admin)[0].text).toContain(`/admin/candidates/${mentee.id}`);
    expect(to(dm.mentee)).toHaveLength(1);
    expect(to(dm.company)).toHaveLength(0);
    expect(to(dm.mentor)).toHaveLength(0);
    expect(await prisma.notification.count({ where: { userId: admin.id, type: 'offer_accepted.admin' } })).toBe(1);
  } finally {
    await api.dispose();
    await new Promise((r) => sink.close(r));
    await prisma.notificationDelivery.deleteMany({ where: { userId: { in: [admin.id, mentor.id, mentee.id, companyUser.id] } } });
    await prisma.chatDelivery.deleteMany({ where: { workspaceId: ws.id } }).catch(() => {});
    await prisma.chatIdentity.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.chatWorkspace.deleteMany({ where: { id: ws.id } });
    await prisma.offer.deleteMany({ where: { relationId: relation.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
    await prisma.interviewRequest.deleteMany({ where: { orgId: org.id } });
    await prisma.application.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await prisma.requisition.deleteMany({ where: { orgId: org.id } });
    await prisma.company.deleteMany({ where: { id: company.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
