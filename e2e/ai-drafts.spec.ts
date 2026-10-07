import { test, expect, type APIRequestContext } from '@playwright/test';
import { cleanupMenteeWithRelation, prisma, seedMenteeWithRelation, type SeededRelation } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';
import { defaultOrgId } from '../src/lib/defaultOrg';
import { loadOutreachFacts, outreachDraftHash } from '../src/lib/outreachFacts';
import { BULK_DRAFT_MAX_RECIPIENTS } from '../src/lib/outreachRules';

// Grounded outreach drafts (#2048, part 2). CI has no provider key, so a fresh
// generation stops at 501 — "the gate ran and nothing was generated" — and the
// one way a draft appears is the stored artefact, which is exactly what makes
// "no provider call" provable. Nothing on these screens sends anything.

const PASSWORD = 'AiDrafts123!';
const DRAFT = { subject: 'Willkommen', body: 'Hallo Ada, ich bin deine Mentorin — lass uns diese Woche kurz sprechen.' };
let pair: SeededRelation;
let other: SeededRelation;
let conversationId = '';
let mentor: APIRequestContext;
let otherMentor: APIRequestContext;
let mentee: APIRequestContext;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  pair = await seedMenteeWithRelation('ai-drafts', PASSWORD);
  other = await seedMenteeWithRelation('ai-drafts-other', PASSWORD);
  await prisma.user.update({ where: { id: pair.menteeId }, data: { preferredLanguage: 'de', fullName: 'Ada Draftee' } });
  conversationId = (
    await prisma.conversation.create({
      data: { type: 'DIRECT', directKey: [pair.mentorId, pair.menteeId].sort().join('|'), participants: { create: [{ userId: pair.mentorId }, { userId: pair.menteeId }] } },
    })
  ).id;
  const baseURL = info.project.use.baseURL;
  [mentor, otherMentor, mentee] = await Promise.all([1, 2, 3].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(mentor, pair.mentorEmail, PASSWORD)).ok).toBe(true);
  expect((await signInViaApi(otherMentor, other.mentorEmail, PASSWORD)).ok).toBe(true);
  expect((await signInViaApi(mentee, pair.menteeEmail, PASSWORD)).ok).toBe(true);
});

// The smoke run greps this test alone, so it may not lean on the ones above it.
const grantConsent = () =>
  prisma.userConsent.upsert({
    where: { userId_type: { userId: pair.menteeId, type: 'AI_INTERACTION_SUMMARY' } },
    create: { userId: pair.menteeId, type: 'AI_INTERACTION_SUMMARY', grantedAt: new Date() },
    update: { revokedAt: null },
  });

test.afterAll(async () => {
  await Promise.all([mentor, otherMentor, mentee].map((c) => c?.dispose()));
  await prisma.aiArtifact.deleteMany({ where: { relationId: pair?.relationId } });
  for (const s of [pair, other]) if (s) await cleanupMenteeWithRelation(s);
});

test('only the pair’s mentor may ask, the mentee’s consent gates it, and nothing is generated without a provider', async () => {
  const url = `/api/mentorship/${pair.relationId}/ai-draft`;
  expect((await mentee.post(url, { data: {} })).status()).toBe(403);
  expect((await otherMentor.post(url, { data: {} })).status()).toBe(403);
  expect((await mentor.post(url, { data: { moment: 'shout' } })).status()).toBe(400);

  const noConsent = await mentor.post(url, { data: {} });
  expect(noConsent.status()).toBe(403);
  expect((await noConsent.json()).code).toBe('consent_required');

  await grantConsent();
  // Consent given, nothing stored, no provider: the gate answers 501 — never a paywall.
  expect((await mentor.post(url, { data: { moment: 'dormant_nudge' } })).status()).toBe(501);
});

test('the bulk draft is refused above the cap before any call, and states its cost on the composer', async ({ page }) => {
  const tooMany = await mentor.post('/api/ai/bulk-draft', { data: { purpose: 'Weekly report reminder', recipientCount: BULK_DRAFT_MAX_RECIPIENTS + 1, locale: 'en' } });
  expect(tooMany.status()).toBe(400);
  expect((await tooMany.json()).code).toBe('batch_too_large');
  // Within the cap the one gated call runs — and without a provider stops at 501.
  expect((await mentor.post('/api/ai/bulk-draft', { data: { purpose: 'Weekly report reminder', recipientCount: 3, locale: 'en' } })).status()).toBe(501);

  await signInAsFreshUser(page, pair.mentorEmail, PASSWORD, '/mentor');
  await gotoSettled(page, `/mentor/email?relation=${pair.relationId}`);
  await expect(page.getByTestId('bulk-draft-cost')).toContainText('1 AI credit for 1 recipient');
  // Opened for an outcome, the panel offers the grounded outcome note instead.
  await gotoSettled(page, `/mentor/email?relation=${pair.relationId}&template=outcomeNoMatch`);
  await expect(page.getByTestId('outcome-ai-draft')).toBeVisible();
});

test('the mentor’s grounded draft lands in the composer as editable text and is never sent', { tag: '@smoke' }, async ({ page }) => {
  // What runAiGated's write-through would have stored for this exact relation
  // state: the same facts loader and key the route uses.
  await grantConsent();
  const rel = await prisma.mentorshipRelation.findUniqueOrThrow({
    where: { id: pair.relationId },
    select: { id: true, orgId: true, mentorId: true, menteeId: true, pipelineStatus: true, dormantSince: true, mentee: { select: { fullName: true, preferredLanguage: true } } },
  });
  const facts = await loadOutreachFacts(rel, { id: pair.mentorId, role: 'MENTOR' }, 'de');
  const mentorRow = await prisma.user.findUniqueOrThrow({ where: { id: pair.mentorId }, select: { orgId: true } });
  await prisma.aiArtifact.create({
    data: {
      orgId: mentorRow.orgId ?? (await defaultOrgId()),
      taskId: 'outreach_draft',
      subjectUserId: pair.menteeId,
      createdById: pair.mentorId,
      relationId: pair.relationId,
      inputHash: outreachDraftHash(pair.relationId, pair.mentorId, 'first_message', 'de', facts),
      content: JSON.stringify(DRAFT),
    },
  });
  const usage = await prisma.aiUsage.count();
  const api = await mentor.post(`/api/mentorship/${pair.relationId}/ai-draft`, { data: { moment: 'auto' } });
  expect(api.status()).toBe(200);
  expect(await api.json()).toMatchObject({ moment: 'first_message', locale: 'de', draft: DRAFT, cached: true });
  expect(await prisma.aiUsage.count()).toBe(usage);

  const before = await prisma.message.count({ where: { conversationId } });
  await signInAsFreshUser(page, pair.mentorEmail, PASSWORD, '/mentor');
  await gotoSettled(page, `/messages/c/${conversationId}`);
  await expect(async () => {
    await page.getByTestId('mentor-ai-draft').click();
    await expect(page.getByTestId('message-input')).toHaveValue(DRAFT.body, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByTestId('ai-draft-badge')).toBeVisible();
  expect(await prisma.message.count({ where: { conversationId } })).toBe(before);
  await page.getByTestId('message-input').fill(`${DRAFT.body} Bis bald!`);
  await expect(page.getByTestId('ai-draft-badge')).toHaveCount(0);
  expect(await prisma.message.count({ where: { conversationId } })).toBe(before);
});
