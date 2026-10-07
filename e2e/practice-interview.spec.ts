import { test, expect, type APIRequestContext } from '@playwright/test';
import { cleanupMenteeWithRelation, prisma, seedMenteeWithRelation, type SeededRelation } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';
import { defaultOrgId } from '../src/lib/defaultOrg';
import { normalizeReport } from '../src/lib/practiceInterviewRules';

// Text-only practice interview (#2051). CI has no provider key: starting one
// and answering stop at the neutral "not available right now" — no paywall, no
// quota, no upgrade, and nothing stored, so the typed answer stays in the box.
// The sessions and the report below are seeded as the routes would write them.

const PW = 'Practice123!';
const UPGRADE = /\b(upgrade|pricing|plan|subscribe|paywall|premium|quota|credit)\b/i;
let pair: SeededRelation;
let mentee: APIRequestContext;
let mentor: APIRequestContext;
let reportId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  pair = await seedMenteeWithRelation('practice', PW);
  await prisma.user.update({ where: { id: pair.menteeId }, data: { targetPosition: 'Backend Intern' } });
  const baseURL = info.project.use.baseURL;
  [mentee, mentor] = await Promise.all([1, 2].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(mentee, pair.menteeEmail, PW)).ok).toBe(true);
  expect((await signInViaApi(mentor, pair.mentorEmail, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([mentee, mentor].map((c) => c?.dispose()));
  await prisma.practiceSession.deleteMany({ where: { userId: pair?.menteeId } });
  await prisma.aiArtifact.deleteMany({ where: { subjectUserId: pair?.menteeId } });
  if (pair) await cleanupMenteeWithRelation(pair);
});

test('only the mentee may practise; without a provider nothing starts and nothing is charged', async () => {
  expect((await mentor.get('/api/interview-prep/session')).status()).toBe(403);
  expect((await mentor.post('/api/interview-prep/session', { data: {} })).status()).toBe(403);
  const usage = await prisma.aiUsage.count();
  const res = await mentee.post('/api/interview-prep/session', { data: {} });
  expect(res.status()).toBe(501);
  const body = await res.json();
  expect(body.code).toBe('not_configured');
  expect(JSON.stringify(body)).not.toMatch(UPGRADE);
  expect(await prisma.practiceSession.count({ where: { userId: pair.menteeId } })).toBe(0);
  expect(await prisma.aiUsage.count()).toBe(usage);
});

test('an answer in a running session is never lost: unavailable leaves it in the box and stores nothing', { tag: '@smoke' }, async ({ page }) => {
  const menteeRow = await prisma.user.findUniqueOrThrow({ where: { id: pair.menteeId }, select: { orgId: true } });
  const s = await prisma.practiceSession.create({
    data: { orgId: menteeRow.orgId ?? (await defaultOrgId()), userId: pair.menteeId, role: 'Backend Intern', turns: [{ q: 'Tell me about an API you built.' }] },
  });
  await signInAsFreshUser(page, pair.menteeEmail, PW, '/portal');
  await gotoSettled(page, '/portal/goals');
  const card = page.locator('[data-testid=practice-interview]:visible');
  await expect(card.getByTestId('practice-current-question')).toHaveText('Tell me about an API you built.');
  await expect(card.getByTestId('practice-progress')).toContainText('Question 1 of 6');
  // Text only: there is nothing to record with.
  await expect(card.locator('audio, video')).toHaveCount(0);
  await expect(async () => {
    await card.getByTestId('practice-answer').fill('A booking API in Kotlin; I cut p95 latency by 40%.');
    await card.getByTestId('practice-send').click();
    await expect(card.getByTestId('practice-notice')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(card.getByTestId('practice-notice')).not.toContainText(UPGRADE);
  await expect(card.getByTestId('practice-answer')).toHaveValue('A booking API in Kotlin; I cut p95 latency by 40%.');
  const stored = await prisma.practiceSession.findUniqueOrThrow({ where: { id: s.id }, select: { turns: true } });
  expect(stored.turns).toEqual([{ q: 'Tell me about an API you built.' }]);
  await prisma.practiceSession.update({ where: { id: s.id }, data: { status: 'COMPLETED', endedAt: new Date() } });
});

test('the report is private until the mentee shares it — the mentor cannot read it before', async ({ page }) => {
  const menteeRow = await prisma.user.findUniqueOrThrow({ where: { id: pair.menteeId }, select: { orgId: true } });
  const report = normalizeReport({ ratings: { structure: 4, evidence: 3, relevance: 4, clarity: 5 }, went_well: ['Clear opening'], work_on: ['Quantify impact', 'Shorter answers'], rewrite: { question: 'Why us?', answer: 'Because…' }, summary: 'A solid first run.' }, 'Backend Intern');
  const artifact = await prisma.aiArtifact.create({
    data: { orgId: menteeRow.orgId ?? (await defaultOrgId()), taskId: 'practice_interview', subjectUserId: pair.menteeId, createdById: pair.menteeId, inputHash: 'practice-e2e', content: JSON.stringify(report) },
  });
  reportId = artifact.id;
  await prisma.practiceSession.create({
    data: { orgId: menteeRow.orgId ?? (await defaultOrgId()), userId: pair.menteeId, role: 'Backend Intern', status: 'COMPLETED', endedAt: new Date(), reportArtifactId: artifact.id, turns: [{ q: 'Q1', a: 'A1' }] },
  });

  // The mentor, before sharing: neither the list nor the artefact itself.
  const before = await (await mentor.get(`/api/ai/artifacts?subjectUserId=${pair.menteeId}`)).json();
  expect((before.artifacts ?? []).map((a: { id: string }) => a.id)).not.toContain(reportId);
  expect([403, 404]).toContain((await mentor.get(`/api/ai/artifacts/${reportId}`)).status());

  // The mentee sees the report on their card.
  await signInAsFreshUser(page, pair.menteeEmail, PW, '/portal');
  await gotoSettled(page, '/portal/goals');
  const card = page.locator('[data-testid=practice-interview]:visible');
  await expect(card.getByTestId('practice-rating-clarity')).toContainText('5');
  await expect(card.getByTestId('practice-report-work-on')).toContainText('Quantify impact');

  // Shared: now the mentor reads it.
  expect((await mentee.patch(`/api/ai/artifacts/${reportId}`, { data: { visibility: 'SHARED_WITH_MENTOR' } })).status()).toBe(200);
  const after = await (await mentor.get(`/api/ai/artifacts?subjectUserId=${pair.menteeId}`)).json();
  expect((after.artifacts ?? []).map((a: { id: string }) => a.id)).toContain(reportId);
});
