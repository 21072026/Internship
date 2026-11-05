import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { slackSignatureFor } from '@/lib/chat/slackSignature';
import { SLASH_COMMAND } from '@/lib/chat/commands';

// Slash commands (#1956), over HTTP through the ONE interaction endpoint:
// `/interncrm status` answers from the app's own relation scope — a mentee
// their own stage, a mentor their pairs — and never anyone else's; an
// unlinked member gets the link prompt; an unknown word is help.

const SECRET = 'e2e-slack-signing-secret';
const PW = 'ChatCommand123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a slash command answers for the verified person only', async ({ playwright, baseURL }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Cmd ${stamp}`, slug: `cmd-${stamp}` } });
  const emails = { mentor: uniqueEmail('cmd-mentor'), mentee: uniqueEmail('cmd-mentee'), other: uniqueEmail('cmd-other') };
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'Cmd Mentor', { orgId: org.id });
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', `Cmd Mentee ${stamp}`, { orgId: org.id });
  const other = await seedUser(emails.other, PW, 'MENTEE', `Cmd Other ${stamp}`, { orgId: org.id });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERVIEW_PENDING_250' } });
  // Another pair in the same org, under another mentor: nobody here may see it.
  const otherMentor = await seedUser(uniqueEmail('cmd-om'), PW, 'MENTOR', 'Cmd Other Mentor', { orgId: org.id });
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: otherMentor.id, menteeId: other.id, pipelineStatus: 'HIRED_660' } });

  const team = `T${stamp}`;
  const ws = await prisma.chatWorkspace.create({ data: { orgId: org.id, platform: 'SLACK', externalId: team, name: 'Acme Slack', scope: 'chat:write,commands', installedById: mentor.id } });
  const ids = { mentor: `UMO${stamp}`, mentee: `UME${stamp}`, stranger: `UST${stamp}` };
  await prisma.chatIdentity.createMany({
    data: [
      { orgId: org.id, workspaceId: ws.id, userId: mentor.id, externalUserId: ids.mentor, verifiedAt: new Date() },
      { orgId: org.id, workspaceId: ws.id, userId: mentee.id, externalUserId: ids.mentee, verifiedAt: new Date() },
    ],
  });

  const received: { text?: string }[] = [];
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

  const command = async (user: string, text: string): Promise<string> => {
    const n = received.length;
    const body = new URLSearchParams({ command: SLASH_COMMAND, text, team_id: team, user_id: user, response_url: sinkUrl, trigger_id: crypto.randomBytes(6).toString('hex') }).toString();
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await api.post('/api/integrations/chat/slack/interactions', {
      data: body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignatureFor(SECRET, ts, body) },
      timeout: 60_000,
    });
    expect(res.status()).toBe(200);
    await expect.poll(() => received.length, { timeout: 60_000 }).toBeGreaterThan(n);
    return received[n].text ?? '';
  };

  try {
    // The mentee: their own stage, nobody else's.
    const own = await command(ids.mentee, 'status');
    expect(own).toMatch(/interview/i);
    expect(own).not.toContain(`Cmd Other ${stamp}`);
    // The mentor: their own pair, not the other mentor's.
    const pairs = await command(ids.mentor, 'status');
    expect(pairs).toContain(`Cmd Mentee ${stamp}`);
    expect(pairs).not.toContain(`Cmd Other ${stamp}`);
    // log is the mentor's; book is the mentee's.
    expect(await command(ids.mentee, 'log')).toContain('person who leads the sessions');
    expect(await command(ids.mentor, 'book')).toContain('active pairing');
    // An unknown word is help; an unlinked member is asked to link first.
    expect(await command(ids.mentor, 'frobnicate')).toContain('You can type');
    expect(await command(ids.stranger, 'status')).toContain('/account');
  } finally {
    await api.dispose();
    await new Promise((r) => sink.close(r));
    await prisma.chatIdentity.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.chatWorkspace.deleteMany({ where: { id: ws.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await cleanupByEmail(otherMentor.email!);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
