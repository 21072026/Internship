import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { createSurvey, submitSurveyResponse } from '../src/lib/surveys';

// The AI pack gates operator AI only (#1738). Tagged @smoke: it is a billing
// boundary and a free-core guard — the two things this repo promises never to
// get wrong (CLAUDE.md, docs/ai.md § The two boundaries).
//
//   • An org WITHOUT the pack: every operator AI route answers the shared
//     `403 feature_locked` (insights, the analytics narrative, the survey
//     summary), their GETs say `locked`, the screens draw the locked line and
//     no Run button; mentor-suggest keeps the rule-based list and names the
//     pack (`locked: 'AI_PACKAGE'`). Nothing is metered.
//   • An org WITH the pack: the same calls go past the gate. CI has no
//     provider key, so they end at the configured gate — a typed reason, never
//     a 403.
//   • The FREE CORE in the org WITHOUT the pack: the mentee's CV feedback and
//     interview prep, and the mentor's interaction summary, answer exactly as
//     they always did (501 not_configured here) — never feature_locked — and
//     the mentee's portal shows no upgrade prompt.
//
// Two orgs of this spec's own, so the shared default org's grants are never
// touched: other specs run on it in parallel.

const PW = 'AiPack123!';
const DAY = 24 * 60 * 60 * 1000;
const LOCKED = { error: 'feature_locked', code: 'feature_locked', feature: 'AI_PACKAGE' };

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedOrg(prefix: string, pack: boolean) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const org = await prisma.organization.create({ data: { name: `${prefix} ${stamp}`, slug: `${prefix.toLowerCase()}-${stamp}` } });
  const emails = { admin: uniqueEmail(`${prefix}-admin`), mentor: uniqueEmail(`${prefix}-mentor`), mentee: uniqueEmail(`${prefix}-mentee`) };
  const admin = await seedUser(emails.admin, PW, 'ADMIN', `${prefix} Admin`, org.id);
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', `${prefix} Mentor`, org.id);
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', `${prefix} Mentee`, org.id);
  await prisma.user.update({ where: { id: mentor.id }, data: { skills: ['Go', 'SQL'] } });
  await prisma.user.update({ where: { id: mentee.id }, data: { skills: ['Go'], targetPosition: 'Backend Developer' } });
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', orgId: org.id } });
  if (pack) await setOrgFeature(org.id, 'AI_PACKAGE', true);
  const cleanup = async () => {
    await prisma.matchFeedback.deleteMany({ where: { menteeId: mentee.id } }).catch(() => {});
    await prisma.aiArtifact.deleteMany({ where: { orgId: org.id } });
    await prisma.aiUsage.deleteMany({ where: { orgId: org.id } });
    await prisma.survey.deleteMany({ where: { orgId: org.id } });
    await prisma.interactionLog.deleteMany({ where: { relationId: rel.id } });
    await prisma.evaluation.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.orgEntitlement.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  };
  return { org, emails, admin, mentor, mentee, rel, cleanup };
}

/** Three evaluation comments: above NAMED_ROWS_FLOOR, so the insights engine reaches the gate rather than the floor. */
async function seedEvaluations(relationId: string, authorId: string) {
  const now = Date.now();
  for (const [i, text] of ['Struggles with Git rebases.', 'Great progress on the API task.', 'Onboarding docs were outdated.'].entries()) {
    await prisma.evaluation.create({ data: { relationId, authorId, comment: text, createdAt: new Date(now - (i + 1) * DAY), submittedAt: new Date(now - (i + 1) * DAY) } });
  }
}

/** One open survey with one free-text question and enough answers to clear its floor. */
async function seedSurvey(orgId: string, stamp: string) {
  const survey = await createSurvey(orgId, {
    key: `aipack-${stamp}`,
    title: { en: `AI pack survey ${stamp}` },
    audience: 'MENTEE',
    anonymity: 'ANONYMOUS',
    questions: [{ key: 'best', type: 'LONG_TEXT', labels: { en: 'What worked best?' } }],
  });
  await prisma.survey.update({ where: { id: survey.id }, data: { status: 'OPEN' } });
  for (const best of ['Pairing sessions', 'The weekly check-ins', 'Mock interviews', 'Code reviews', 'Feedback on my CV']) {
    await submitSurveyResponse({ surveyId: survey.id, respondentRole: 'MENTEE', answers: { best } });
  }
  return survey;
}

function sixMonths() {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 6);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

/** Every operator AI call, as an admin of `page`'s session. */
async function operatorCalls(page: Page, surveyId: string, menteeId: string) {
  const range = sixMonths();
  const insightsGet = await page.request.get('/api/admin/insights/evaluations');
  const insightsPost = await page.request.post('/api/admin/insights/evaluations', { data: {} });
  const narrativeGet = await page.request.get(`/api/admin/analytics/narrative?from=${range.from}&to=${range.to}`);
  const narrativePost = await page.request.post('/api/admin/analytics/narrative', { data: range });
  const surveyPost = await page.request.post(`/api/admin/surveys/${surveyId}/summary`, { data: { questionKey: 'best' } });
  const suggest = await page.request.post('/api/admin/mentor-suggest', { data: { menteeId } });
  return { insightsGet, insightsPost, narrativeGet, narrativePost, surveyPost, suggest };
}

test('operator AI is locked without the AI pack and open with it; nothing is metered on the locked path', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const locked = await seedOrg('AiPackOff', false);
  const granted = await seedOrg('AiPackOn', true);
  const stamp = `${Date.now()}`;
  try {
    await seedEvaluations(locked.rel.id, locked.mentor.id);
    await seedEvaluations(granted.rel.id, granted.mentor.id);
    const lockedSurvey = await seedSurvey(locked.org.id, `${stamp}-off`);
    const grantedSurvey = await seedSurvey(granted.org.id, `${stamp}-on`);
    const usageBefore = await prisma.aiUsage.count();

    // ── Without the pack ────────────────────────────────────────────────────
    await signInAndSettle(page, locked.emails.admin, PW, '/admin');
    const off = await operatorCalls(page, lockedSurvey.id, locked.mentee.id);

    expect(off.insightsGet.status()).toBe(200);
    expect(await off.insightsGet.json()).toMatchObject({ locked: true, summary: null, available: 3 });
    expect(off.insightsPost.status()).toBe(403);
    expect(await off.insightsPost.json()).toMatchObject(LOCKED);

    expect(off.narrativeGet.status()).toBe(200);
    expect(await off.narrativeGet.json()).toMatchObject({ locked: true, narrative: null });
    expect(off.narrativePost.status()).toBe(403);
    expect(await off.narrativePost.json()).toMatchObject(LOCKED);

    expect(off.surveyPost.status()).toBe(403);
    expect(await off.surveyPost.json()).toMatchObject(LOCKED);

    // The authoring assists (#2055) and an admin's bulk draft (#2048) are
    // operator tasks too.
    for (const [url, data] of [
      ['/api/admin/ai/translate', { purpose: 'goal_template', from: 'en', text: 'Ship one small PR', to: ['tr', 'de'] }],
      ['/api/admin/ai/draft', { purpose: 'announcement', brief: 'CV workshop Thursday' }],
      ['/api/admin/ai/company-enrich', { text: 'Acme GmbH, Berlin. We build payment APIs. Contact: jobs@acme.example' }],
      ['/api/ai/bulk-draft', { purpose: 'Weekly report reminder', recipientCount: 3, locale: 'en' }],
    ] as const) {
      const res = await page.request.post(url, { data });
      expect(res.status(), url).toBe(403);
      expect(await res.json()).toMatchObject(LOCKED);
    }

    // The ranking is not AI: the list stays, the rationale does not, and the
    // response names the pack instead of pretending nothing is missing.
    expect(off.suggest.status()).toBe(200);
    const offSuggest = await off.suggest.json();
    expect(offSuggest).toMatchObject({ aiUsed: false, locked: 'AI_PACKAGE' });
    expect(offSuggest.suggestions.length).toBeGreaterThan(0);
    expect(offSuggest.suggestions[0]).toMatchObject({ mentorId: locked.mentor.id });

    // A locked org spends nothing.
    expect(await prisma.aiUsage.count()).toBe(usageBefore);

    // The screens: one line, no button.
    await page.goto('/admin/insights');
    await expect(page.getByTestId('insights-locked').first()).toBeVisible();
    await expect(page.getByTestId('insights-summarise')).toHaveCount(0);
    await page.goto('/admin/analytics');
    await expect(page.getByTestId('analytics-narrative-locked')).toBeVisible();
    await expect(page.getByTestId('analytics-narrative-write')).toHaveCount(0);

    // ── With the pack ───────────────────────────────────────────────────────
    const onCtx = await page.context().browser()!.newContext();
    const onPage = await onCtx.newPage();
    try {
      await signInAndSettle(onPage, granted.emails.admin, PW, '/admin');
      const on = await operatorCalls(onPage, grantedSurvey.id, granted.mentee.id);
      // Past the gate: with no provider key here the typed reason is the
      // configured gate's, never a 403.
      const typed = ['not_configured', 'quota_exceeded'];
      expect(on.insightsGet.status()).toBe(200);
      expect((await on.insightsGet.json()).locked).toBe(false);
      expect(on.insightsPost.status()).toBe(200);
      expect(typed).toContain((await on.insightsPost.json()).reason);
      expect(on.narrativeGet.status()).toBe(200);
      expect((await on.narrativeGet.json()).locked).toBe(false);
      expect(on.narrativePost.status()).toBe(200);
      expect(typed).toContain((await on.narrativePost.json()).reason);
      expect(on.surveyPost.status()).toBe(200);
      expect(typed).toContain((await on.surveyPost.json()).reason);
      expect(on.suggest.status()).toBe(200);
      const onSuggest = await on.suggest.json();
      expect(onSuggest.aiUsed).toBe(false);
      expect('locked' in onSuggest).toBe(false);
      expect(onSuggest.suggestions[0]).toMatchObject({ mentorId: granted.mentor.id });
      // A denial at the configured gate costs nothing either (the pre-#1738 contract).
      expect(await prisma.aiUsage.count()).toBe(usageBefore);
    } finally {
      await onCtx.close();
    }
  } finally {
    await locked.cleanup();
    await granted.cleanup();
  }
});

test('the free core never sees the AI pack: mentee and mentor AI answer as before in an org without it', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const org = await seedOrg('AiPackFree', false);
  try {
    const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
    await prisma.cvFile.create({ data: { userId: org.mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf } });
    await prisma.interactionLog.create({ data: { relationId: org.rel.id, type: 'Meeting', subject: 'Kick-off', notes: 'Agreed on a weekly call.', date: new Date() } });
    const usageBefore = await prisma.aiUsage.count();
    const neverLocked = async (res: { status(): number; json(): Promise<Record<string, unknown>> }) => {
      const body = await res.json();
      expect(res.status()).not.toBe(403);
      expect(body.code).not.toBe('feature_locked');
      expect(['not_configured', 'quota_exceeded']).toContain(body.code);
    };

    // The mentee's own tools.
    await signInAndSettle(page, org.emails.mentee, PW, '/portal');
    await page.request.post('/api/consent', { data: { type: 'AI_CV_PARSING', granted: true } });
    await page.request.post('/api/consent', { data: { type: 'AI_INTERACTION_SUMMARY', granted: true } });
    await neverLocked(await page.request.post('/api/cv/feedback', { data: {} }));
    await neverLocked(await page.request.post('/api/interview-prep', { data: { position: 'Backend Developer' } }));
    // No upgrade prompt anywhere on the portal.
    await page.goto('/portal');
    await expect(page.locator('body')).not.toContainText(/upgrade|yükselt|upgraden/i);

    // The mentor's own view of their own mentee.
    const mentorCtx = await page.context().browser()!.newContext();
    const mentorPage = await mentorCtx.newPage();
    try {
      await signInAndSettle(mentorPage, org.emails.mentor, PW, '/mentor');
      await neverLocked(await mentorPage.request.post('/api/interactions/summary', { data: { relationId: org.rel.id } }));
      // A mentor's bulk draft to their own mentees stays free (an admin's is operator use, asserted above).
      await neverLocked(await mentorPage.request.post('/api/ai/bulk-draft', { data: { purpose: 'Weekly report reminder', recipientCount: 3, locale: 'en' } }));
      expect((await (await mentorPage.request.get(`/api/interactions/summary?relationId=${org.rel.id}`)).json()).locked).toBeUndefined();
    } finally {
      await mentorCtx.close();
    }
    // The same summary read by an ADMIN of a pair that is not theirs is an
    // admin tool: that one call is operator use, and without the pack it is
    // locked — on the run and on the stored-copy read alike.
    const adminCtx = await page.context().browser()!.newContext();
    const adminPage = await adminCtx.newPage();
    try {
      await signInAndSettle(adminPage, org.emails.admin, PW, '/admin');
      const run = await adminPage.request.post('/api/interactions/summary', { data: { relationId: org.rel.id } });
      expect(run.status()).toBe(403);
      expect(await run.json()).toMatchObject(LOCKED);
      expect(await (await adminPage.request.get(`/api/interactions/summary?relationId=${org.rel.id}`)).json()).toMatchObject({ latest: null, locked: true });
    } finally {
      await adminCtx.close();
    }
    expect(await prisma.aiUsage.count()).toBe(usageBefore);
  } finally {
    await org.cleanup();
  }
});
