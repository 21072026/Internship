import { test, expect, type APIRequestContext } from '@playwright/test';
import { cleanupMenteeWithRelation, prisma, seedMenteeWithRelation, type SeededRelation } from './helpers/db';
import { signInAsFreshUser, signInViaApi } from './helpers/auth';
import { hashInput } from '../src/lib/ai/artifacts';
import { defaultOrgId } from '../src/lib/defaultOrg';

// Thread catch-up and suggested replies (#2048). CI has no provider key, so a
// fresh generation stops at 501 — which is what makes "answered from the stored
// artefact, no provider call, no quota" provable. The artefacts below are what
// runAiGated's write-through would have stored for this exact thread state.

const PASSWORD = 'ThreadAi123!';
let pair: SeededRelation;
let outsider: SeededRelation;
let conversationId = '';
let lastId = '';
let mentor: APIRequestContext;
let stranger: APIRequestContext;
const SUMMARY = '• Ada asked to move the check-in to Friday.\n• Ben agreed; the CV draft is due before then.';
const DRAFT = 'Freitag passt mir gut — ich schicke dir vorher den Lebenslauf.';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  pair = await seedMenteeWithRelation('thread-ai', PASSWORD);
  outsider = await seedMenteeWithRelation('thread-ai-out', PASSWORD);
  // The mentor reads English; the mentee — the reply's recipient — German.
  await prisma.user.update({ where: { id: pair.mentorId }, data: { preferredLanguage: 'en' } });
  await prisma.user.update({ where: { id: pair.menteeId }, data: { preferredLanguage: 'de' } });
  const conversation = await prisma.conversation.create({
    data: { type: 'DIRECT', directKey: [pair.mentorId, pair.menteeId].sort().join('|'), participants: { create: [{ userId: pair.mentorId }, { userId: pair.menteeId }] } },
  });
  conversationId = conversation.id;
  const t0 = Date.now() - 60 * 60_000;
  await prisma.message.create({ data: { conversationId, senderId: pair.mentorId, body: 'Can we move our check-in?', createdAt: new Date(t0), readAt: new Date() } });
  const last = await prisma.message.create({ data: { conversationId, senderId: pair.menteeId, body: 'Ja, Freitag?', createdAt: new Date(t0 + 60_000), readAt: new Date() } });
  lastId = last.id;
  // The mentee's words are processed: their consent gates the call.
  await prisma.userConsent.create({ data: { userId: pair.menteeId, type: 'AI_INTERACTION_SUMMARY', grantedAt: new Date() } });

  const mentorUser = await prisma.user.findUnique({ where: { id: pair.mentorId }, select: { orgId: true } });
  const orgId = mentorUser?.orgId ?? (await defaultOrgId());
  await prisma.aiArtifact.createMany({
    data: [
      { orgId, taskId: 'thread_summary', subjectUserId: null, createdById: pair.mentorId, content: SUMMARY,
        inputHash: hashInput({ conversationId, reader: pair.mentorId, last: lastId, edited: null, locale: 'en' }) },
      { orgId, taskId: 'suggested_reply', subjectUserId: null, createdById: pair.mentorId, content: DRAFT,
        inputHash: hashInput({ conversationId, author: pair.mentorId, last: lastId, edited: null, locale: 'de', tone: 'warm' }) },
    ],
  });

  const baseURL = info.project.use.baseURL;
  mentor = await playwright.request.newContext({ baseURL });
  stranger = await playwright.request.newContext({ baseURL });
  expect((await signInViaApi(mentor, pair.mentorEmail, PASSWORD)).ok).toBe(true);
  expect((await signInViaApi(stranger, outsider.mentorEmail, PASSWORD)).ok).toBe(true);
});

test.afterAll(async () => {
  await mentor?.dispose();
  await stranger?.dispose();
  await prisma.aiArtifact.deleteMany({ where: { createdById: { in: [pair?.mentorId, outsider?.mentorId].filter(Boolean) as string[] } } });
  for (const s of [pair, outsider]) if (s) await cleanupMenteeWithRelation(s);
});

test('a participant catches up from the stored summary at no cost; nobody else can ask', async () => {
  const usage = await prisma.aiUsage.count();
  const res = await mentor.post(`/api/conversations/${conversationId}/summary`, { data: {} });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ summary: SUMMARY, cached: true });
  expect(await prisma.aiUsage.count()).toBe(usage);
  // Regenerate is a real call, which without a provider is 501 — never a paywall.
  expect((await mentor.post(`/api/conversations/${conversationId}/summary`, { data: { regenerate: true } })).status()).toBe(501);
  // A non-participant is refused before anything is read.
  expect((await stranger.post(`/api/conversations/${conversationId}/summary`, { data: {} })).status()).toBe(403);
  expect((await stranger.post(`/api/conversations/${conversationId}/suggest-reply`, { data: { tone: 'warm' } })).status()).toBe(403);
  expect((await mentor.post(`/api/conversations/${conversationId}/suggest-reply`, { data: { tone: 'sarcastic' } })).status()).toBe(400);
});

test('without the quoted person’s consent there is no catch-up and no reply', async () => {
  await prisma.userConsent.update({ where: { userId_type: { userId: pair.menteeId, type: 'AI_INTERACTION_SUMMARY' } }, data: { revokedAt: new Date() } });
  try {
    const res = await mentor.post(`/api/conversations/${conversationId}/summary`, { data: {} });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('consent_required');
    expect((await mentor.post(`/api/conversations/${conversationId}/suggest-reply`, { data: { tone: 'warm' } })).status()).toBe(403);
  } finally {
    await prisma.userConsent.update({ where: { userId_type: { userId: pair.menteeId, type: 'AI_INTERACTION_SUMMARY' } }, data: { revokedAt: null } });
  }
});

test('a suggested reply lands in the composer as an editable draft in the recipient’s language and is never sent', { tag: '@smoke' }, async ({ page }) => {
  await signInAsFreshUser(page, pair.mentorEmail, PASSWORD, '/mentor');
  await page.goto(`/messages/c/${conversationId}`);
  await expect(page.getByTestId('thread-messages').getByText('Ja, Freitag?', { exact: true })).toBeVisible();

  // Catch-up first: the stored summary, shown above the thread.
  await page.getByTestId('thread-catchup-button').click();
  await expect(page.getByTestId('thread-catchup-summary')).toContainText('Ben agreed');

  const before = await prisma.message.count({ where: { conversationId } });
  await page.getByTestId('suggest-reply-toggle').click();
  await page.getByTestId('suggest-reply-warm').click();
  const box = page.getByTestId('message-input');
  await expect(box).toHaveValue(DRAFT);
  await expect(page.getByTestId('ai-draft-badge')).toBeVisible();
  // Nothing was sent: the draft is only text in the box.
  expect(await prisma.message.count({ where: { conversationId } })).toBe(before);
  // Editing makes it the author's own message — the ✨ mark goes.
  await box.fill(`${DRAFT} Bis dann!`);
  await expect(page.getByTestId('ai-draft-badge')).toHaveCount(0);
  expect(await prisma.message.count({ where: { conversationId } })).toBe(before);
});
