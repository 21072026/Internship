import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { slackSignatureFor } from '@/lib/chat/slackSignature';
import { E2E_BOTFRAMEWORK_MOCK_PORT } from '../playwright.config';

// The ONE chat interaction endpoint (#1948), over HTTP against the dev server:
//
//  · Slack: a missing, wrong or stale signature is the same opaque 401, and a
//    captured request replayed inside the window is refused too;
//  · a valid click from a member with a CONFIRMED identity runs the action as
//    that person — their own next meeting comes back on the response_url;
//  · a forged member id, and a member whose link is still unconfirmed, get the
//    "link your account first" reply and nothing else (no meeting leaks);
//  · Teams: only a Bot Framework token for our app id gets through, and a
//    Universal Action is answered in the invoke response.
//
// The reply sink is a loopback server in this process; the dev server may post
// there only under CHAT_RESPONSE_URL_ALLOW_INSECURE_STUB (playwright.config.ts).

const SECRET = 'e2e-slack-signing-secret';
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const PW = 'ChatInteract123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('chat interactions: signature, replay window, and the person re-derived from a confirmed identity', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `ChatAct ${stamp}`, slug: `chatact-${stamp}` } });
  const emails = { mentor: uniqueEmail('ci-mentor'), mentee: uniqueEmail('ci-mentee'), other: uniqueEmail('ci-other') };
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'CI Mentor', { orgId: org.id });
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', 'CI Mentee', { orgId: org.id });
  const other = await seedUser(emails.other, PW, 'MENTEE', 'CI Other', { orgId: org.id });
  const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id } });
  const title = `Chat Next ${stamp}`;
  const meeting = await prisma.meeting.create({
    data: { relationId: relation.id, title, scheduledAt: new Date(Date.now() + 2 * 24 * 3600_000), createdById: mentor.id, rsvpToken: crypto.randomBytes(16).toString('hex') },
  });
  const team = `T${stamp}`;
  const tenant = `tid-${stamp}`;
  const slack = await prisma.chatWorkspace.create({
    data: { orgId: org.id, platform: 'SLACK', externalId: team, name: 'Acme Slack', scope: 'chat:write', installedById: mentor.id },
  });
  const teams = await prisma.chatWorkspace.create({
    data: { orgId: org.id, platform: 'TEAMS', externalId: tenant, name: 'Acme Teams', scope: 'bot', installedById: mentor.id },
  });
  await prisma.chatIdentity.createMany({
    data: [
      { orgId: org.id, workspaceId: slack.id, userId: mentee.id, externalUserId: `U${stamp}`, verifiedAt: new Date() },
      // Proposed by the directory sync, never confirmed by the person.
      { orgId: org.id, workspaceId: slack.id, userId: other.id, externalUserId: `UX${stamp}`, verifiedAt: null },
      { orgId: org.id, workspaceId: teams.id, userId: mentee.id, externalUserId: `aad-${stamp}`, verifiedAt: new Date() },
    ],
  });

  const received: { text?: string; response_type?: string }[] = [];
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
  const mock = await playwright.request.newContext();
  const slackBody = (user: string, responseUrl = sinkUrl) =>
    new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: team },
        user: { id: user },
        actions: [{ action_id: 'meetings.upcoming', value: 'x' }],
        response_url: responseUrl,
      }),
    }).toString();
  const postSlack = (body: string, headers: Record<string, string>) =>
    api.post('/api/integrations/chat/slack/interactions', {
      data: body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      timeout: 60_000,
    });
  const signed = (body: string, ts = Math.floor(Date.now() / 1000)) => ({
    'x-slack-request-timestamp': String(ts),
    'x-slack-signature': slackSignatureFor(SECRET, String(ts), body),
  });
  const waitFor = async (n: number) => {
    await expect.poll(() => received.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(n);
    return received[n - 1];
  };

  try {
    const mine = slackBody(`U${stamp}`);
    // 1–3: nothing unverified gets past the door, and every refusal looks the same.
    const none = await postSlack(mine, {});
    expect(none.status()).toBe(401);
    const opaque = await none.json();
    const wrong = await postSlack(mine, { ...signed(mine), 'x-slack-signature': 'v0=' + '0'.repeat(64) });
    expect(wrong.status()).toBe(401);
    expect(await wrong.json()).toEqual(opaque);
    // A body other than the one signed is a wrong signature too.
    expect((await postSlack(slackBody(`U${stamp}`, sinkUrl + '?x'), signed(mine))).status()).toBe(401);
    const stale = await postSlack(mine, signed(mine, Math.floor(Date.now() / 1000) - 10 * 60));
    expect(stale.status()).toBe(401);
    expect(await stale.json()).toEqual(opaque);
    expect(received).toHaveLength(0);

    // A confirmed member: the action runs as the person, their own meeting comes back.
    const headers = signed(mine);
    const ok = await postSlack(mine, headers);
    expect(ok.status()).toBe(200);
    const reply = await waitFor(1);
    expect(reply.response_type).toBe('ephemeral');
    expect(reply.text).toContain(title);

    // The same request again, inside the window: refused, nothing posted.
    const replay = await postSlack(mine, headers);
    expect(replay.status()).toBe(401);
    expect(await replay.json()).toEqual(opaque);

    // A forged member id, then an unconfirmed one: the link-first reply only.
    const forged = slackBody(`UFORGED${stamp}`);
    expect((await postSlack(forged, signed(forged))).status()).toBe(200);
    const forgedReply = await waitFor(2);
    expect(forgedReply.text).toContain('/account');
    expect(forgedReply.text).not.toContain(title);
    const unconfirmed = slackBody(`UX${stamp}`);
    expect((await postSlack(unconfirmed, signed(unconfirmed))).status()).toBe(200);
    const unconfirmedReply = await waitFor(3);
    expect(unconfirmedReply.text).toContain('/account');
    expect(unconfirmedReply.text).not.toContain(title);

    // A response_url that is not Slack's is never called.
    const elsewhere = slackBody(`U${stamp}`, 'https://attacker.example/hook');
    expect((await postSlack(elsewhere, signed(elsewhere))).status()).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect(received).toHaveLength(3);

    // Teams: the Bot Framework token is the door; the reply is the invoke response.
    const sign = async (claims: Record<string, unknown>) =>
      (await (await mock.post(`http://127.0.0.1:${E2E_BOTFRAMEWORK_MOCK_PORT}/__sign`, { data: { claims } })).json()).token as string;
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: 'https://api.botframework.com', aud: 'e2e-teams-app', nbf: now - 10, exp: now + 600, serviceUrl: SERVICE };
    const invoke = (aad: string) => ({
      type: 'invoke',
      name: 'adaptiveCard/action',
      id: `act-${crypto.randomBytes(4).toString('hex')}`,
      serviceUrl: SERVICE,
      from: { id: '29:x', aadObjectId: aad },
      channelData: { tenant: { id: tenant } },
      value: { action: { type: 'Action.Execute', verb: 'meetings.upcoming', data: {} } },
    });
    const postTeams = (path: string, body: unknown, authorization?: string) =>
      api.post(`/api/integrations/chat/teams/${path}`, { data: body, headers: authorization ? { authorization } : {}, timeout: 60_000 });
    expect((await postTeams('interactions', invoke(`aad-${stamp}`))).status()).toBe(401);
    expect((await postTeams('interactions', invoke(`aad-${stamp}`), `Bearer ${await sign({ ...claims, aud: 'another-bot' })}`)).status()).toBe(401);
    for (const path of ['interactions', 'messages']) {
      const res = await postTeams(path, invoke(`aad-${stamp}`), `Bearer ${await sign(claims)}`);
      expect(res.status()).toBe(200);
      const json = await res.json();
      expect(json.statusCode).toBe(200);
      expect(json.value).toContain(title);
    }
    const teamsForged = await (await postTeams('interactions', invoke(`aad-forged-${stamp}`), `Bearer ${await sign(claims)}`)).json();
    expect(teamsForged.value).toContain('/account');
    expect(teamsForged.value).not.toContain(title);
  } finally {
    await api.dispose();
    await mock.dispose();
    await new Promise((r) => sink.close(r));
    await prisma.chatIdentity.deleteMany({ where: { workspaceId: { in: [slack.id, teams.id] } } });
    await prisma.chatWorkspace.deleteMany({ where: { id: { in: [slack.id, teams.id] } } });
    await prisma.meeting.deleteMany({ where: { id: meeting.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
