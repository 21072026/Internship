import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { slackSignatureFor } from '@/lib/chat/slackSignature';
import { createSurveyInvitation } from '@/lib/surveyTokens';
import { reminderRefusal, REMINDER_SELECT } from '@/lib/surveyReminders';

// Check-ins in chat (#1953), over HTTP through the one interaction endpoint:
//
//  · "Answer now" asks the survey's questions one at a time as buttons, and
//    the last click hands the whole response to the engine's own
//    submitSurveyResponse() — the invitation is claimed (respondedAt), so the
//    reminder that would have followed is refused as `responded`;
//  · an ANONYMOUS survey answered in chat stores no invitation and no
//    respondent: the answer cannot be joined back to the chat member;
//  · only the invitation's own person can answer it; a replayed last click is
//    "already answered"; a survey with a free-text question goes to the page.

const SECRET = 'e2e-slack-signing-secret';
const PW = 'ChatCheckin123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

type Reply = { text?: string; replace_original?: boolean; blocks?: { elements?: { action_id?: string; value?: string; text?: { text: string } }[] }[] };
const buttonsOf = (r: Reply) => (r.blocks ?? []).flatMap((b) => b.elements ?? []).filter((e) => e.action_id);

test('check-ins answered in chat land through the survey engine, anonymity intact', async ({ playwright, baseURL }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Checkin ${stamp}`, slug: `checkin-${stamp}` } });
  const emails = { mentee: uniqueEmail('ck-mentee'), other: uniqueEmail('ck-other') };
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', 'CK Mentee', { orgId: org.id });
  const other = await seedUser(emails.other, PW, 'MENTEE', 'CK Other', { orgId: org.id });

  const survey = async (anonymity: 'CONFIDENTIAL' | 'ANONYMOUS', questions: { key: string; type: string; required: boolean }[]) =>
    prisma.survey.create({
      data: {
        orgId: org.id,
        key: `ck-${anonymity}-${stamp}-${questions.length}`,
        title: { en: 'Pulse' },
        audience: 'MENTEE',
        anonymity,
        status: 'OPEN',
        questions: { create: questions.map((q, i) => ({ ...q, labels: { en: `Question ${q.key}` }, sortOrder: i })) },
      },
    });
  const pulse = await survey('CONFIDENTIAL', [
    { key: 'nps', type: 'NPS', required: true },
    { key: 'ok', type: 'BOOLEAN', required: false },
  ]);
  const anonymous = await survey('ANONYMOUS', [{ key: 'mood', type: 'SCALE', required: true }]);
  const withText = await survey('CONFIDENTIAL', [
    { key: 'nps', type: 'NPS', required: true },
    { key: 'why', type: 'LONG_TEXT', required: false },
  ]);
  const invite = async (surveyId: string) =>
    (await createSurveyInvitation({ surveyId, orgId: org.id, email: emails.mentee, userId: mentee.id, locale: 'en' }))!.invitationId;
  const pulseInv = await invite(pulse.id);
  const anonInv = await invite(anonymous.id);
  const textInv = await invite(withText.id);

  const team = `T${stamp}`;
  const ws = await prisma.chatWorkspace.create({
    data: { orgId: org.id, platform: 'SLACK', externalId: team, name: 'Acme Slack', scope: 'chat:write', installedById: mentee.id },
  });
  const ids = { mentee: `UME${stamp}`, other: `UOT${stamp}` };
  await prisma.chatIdentity.createMany({
    data: [
      { orgId: org.id, workspaceId: ws.id, userId: mentee.id, externalUserId: ids.mentee, verifiedAt: new Date() },
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

  try {
    // Somebody else's invitation: nothing is asked.
    expect(buttonsOf(await click(ids.other, 'survey.start', pulseInv))).toHaveLength(0);

    // Question 1: NPS, required — eleven buttons, no Skip.
    const q1 = buttonsOf(await click(ids.mentee, 'survey.start', pulseInv));
    expect(q1).toHaveLength(11);
    expect(q1.map((b) => b.text?.text)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    // Question 2: BOOLEAN, optional — Yes, No and Skip.
    const q2 = buttonsOf(await click(ids.mentee, 'survey.answer', q1[9].value!));
    expect(q2).toHaveLength(3);
    expect(await prisma.surveyResponse.count({ where: { surveyId: pulse.id } })).toBe(0);
    const yes = q2[0].value!;
    const done = await click(ids.mentee, 'survey.answer', yes);
    expect(done.replace_original).toBe(true);

    // Stored through the engine: the invitation is claimed, the answers are the clicks.
    const response = await prisma.surveyResponse.findFirstOrThrow({ where: { surveyId: pulse.id }, include: { answers: true } });
    expect(response).toMatchObject({ invitationId: pulseInv, respondentId: mentee.id, respondentRole: 'MENTEE' });
    expect(Object.fromEntries(response.answers.map((a) => [a.questionKey, a.value]))).toEqual({ nps: 9, ok: true });
    const claimed = await prisma.surveyInvitation.findUniqueOrThrow({ where: { id: pulseInv }, select: REMINDER_SELECT });
    expect(claimed.respondedAt).not.toBeNull();
    expect(reminderRefusal(claimed, new Date(Date.now() + 10 * 86_400_000), false)).toBe('responded');

    // The last click replayed: already answered, still one response.
    await click(ids.mentee, 'survey.answer', yes);
    expect(await prisma.surveyResponse.count({ where: { surveyId: pulse.id } })).toBe(1);

    // ANONYMOUS: answered in chat, joined to nobody.
    const mood = buttonsOf(await click(ids.mentee, 'survey.start', anonInv));
    expect(mood.map((b) => b.text?.text)).toEqual(['1', '2', '3', '4', '5']);
    await click(ids.mentee, 'survey.answer', mood[3].value!);
    const anon = await prisma.surveyResponse.findFirstOrThrow({ where: { surveyId: anonymous.id } });
    expect(anon).toMatchObject({ invitationId: null, respondentId: null, relationId: null });
    expect(JSON.stringify(anon)).not.toContain(mentee.id);
    expect(JSON.stringify(anon)).not.toContain(ids.mentee);

    // A free-text question: the page, not a partial answer.
    const toPage = await click(ids.mentee, 'survey.start', textInv);
    expect(buttonsOf(toPage)).toHaveLength(0);
    expect(toPage.text).toContain('/s/');
    expect(await prisma.surveyResponse.count({ where: { surveyId: withText.id } })).toBe(0);
  } finally {
    await api.dispose();
    await new Promise((r) => sink.close(r));
    await prisma.chatIdentity.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.chatWorkspace.deleteMany({ where: { id: ws.id } });
    await prisma.survey.deleteMany({ where: { orgId: org.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
