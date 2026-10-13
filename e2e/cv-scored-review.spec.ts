import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { cleanupMenteeWithRelation, prisma, seedMenteeWithRelation, type SeededRelation } from './helpers/db';
import { gotoSettled, signInAsFreshUser } from './helpers/auth';
import { defaultOrgId } from '../src/lib/defaultOrg';
import { normalizeReview } from '../src/lib/cvReviewRules';

// The scored CV review (#2050). CI has no provider key, so a fresh review
// stops at 501 — and the stored reviews below are how a score appears at all.
// The free-core contract is the point of half of this spec: no denial path
// shows a paywall or an upgrade prompt, the card included.

const PW = 'CvScore123!';
let pair: SeededRelation;
let linkedReq = '';
let foreignReq = '';
const UPGRADE = /\b(upgrade|pricing|plan|subscribe|paywall|premium)\b/i;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  pair = await seedMenteeWithRelation('cvscore', PW);
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({ data: { userId: pair.menteeId, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf } });
  // What the upload route stamps; the profile shows the CV tools only then.
  await prisma.user.update({ where: { id: pair.menteeId }, data: { cvUrl: `/api/cv/${pair.menteeId}` } });
  await prisma.userConsent.upsert({
    where: { userId_type: { userId: pair.menteeId, type: 'AI_CV_PARSING' } },
    create: { userId: pair.menteeId, type: 'AI_CV_PARSING', grantedAt: new Date() },
    update: { revokedAt: null },
  });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: pair.companyId }, select: { orgId: true } });
  const orgId = company.orgId ?? (await defaultOrgId());
  const req = (title: string) => prisma.requisition.create({ data: { orgId, companyId: pair.companyId, title, openings: 1, status: 'OPEN', requiredSkills: ['TypeScript', 'Kubernetes'] } });
  linkedReq = (await req('Platform Intern (scored review)')).id;
  foreignReq = (await req('Unrelated role (scored review)')).id;
  await prisma.companyInterest.create({ data: { companyId: pair.companyId, menteeId: pair.menteeId, requisitionId: linkedReq, scopeKey: `requisition:${linkedReq}:${pair.menteeId}`, status: 'INTERESTED' } });

  // Two kept reviews: last week's 55, today's 68.
  const mentee = await prisma.user.findUniqueOrThrow({ where: { id: pair.menteeId }, select: { orgId: true } });
  const artifactOrg = mentee.orgId ?? (await defaultOrgId());
  const review = (score: number) =>
    JSON.stringify(normalizeReview({
      score,
      summary: 'A clear CV that needs measurable results.',
      sections: [{ key: 'impact', score: 40, findings: ['Duties, not outcomes'] }],
      checklist: [{ item: 'Add numbers to two bullet points', status: 'missing', how_to_fix: 'e.g. "cut load time by 30%".' }, { item: 'Contact details', status: 'ok', how_to_fix: '' }],
    }));
  await prisma.aiArtifact.create({ data: { orgId: artifactOrg, taskId: 'cv_feedback', subjectUserId: pair.menteeId, createdById: pair.menteeId, inputHash: 'cvscore-old', content: review(55), createdAt: new Date(Date.now() - 7 * 86_400_000) } });
  await prisma.aiArtifact.create({ data: { orgId: artifactOrg, taskId: 'cv_feedback', subjectUserId: pair.menteeId, createdById: pair.menteeId, inputHash: 'cvscore-new', content: review(68) } });
});

test.afterAll(async () => {
  await prisma.aiArtifact.deleteMany({ where: { subjectUserId: pair?.menteeId } });
  await prisma.companyInterest.deleteMany({ where: { menteeId: pair?.menteeId } });
  await prisma.requisition.deleteMany({ where: { id: { in: [linkedReq, foreignReq].filter(Boolean) } } });
  if (pair) await cleanupMenteeWithRelation(pair);
});

test('the mentee sees their score, band, checklist and the delta since last time — and no upgrade prompt anywhere', { tag: '@smoke' }, async ({ page }) => {
  await signInAsFreshUser(page, pair.menteeEmail, PW, '/portal');
  const state = await (await page.request.get('/api/cv/feedback')).json();
  expect(state).toMatchObject({ hasCv: true, configured: false, previousScore: 55 });
  expect(state.roles).toEqual([expect.objectContaining({ id: linkedReq, title: 'Platform Intern (scored review)' })]);

  await gotoSettled(page, '/portal/profile');
  const card = page.locator('[data-testid=cv-feedback]:visible');
  await expect(card.getByTestId('cv-review-score')).toContainText('68');
  await expect(card.getByTestId('cv-review-band')).toHaveText('Nearly there');
  await expect(card.getByTestId('cv-review-delta')).toHaveText('+13 since your last review');
  await expect(card.locator('[data-testid^=cv-review-section-]')).toHaveCount(6);
  await expect(card.getByTestId('cv-review-check-missing')).toContainText('Add numbers to two bullet points');
  // No provider: the stored review is shown, there is no button to spend — and nothing to buy.
  await expect(card.getByRole('button', { name: /get feedback/i })).toHaveCount(0);
  await expect(card).not.toContainText(UPGRADE);
});

test('every denial is neutral, and tailoring is limited to roles the mentee is connected to', async ({ page }) => {
  await signInAsFreshUser(page, pair.menteeEmail, PW, '/portal');
  // A role the mentee has no link to reads as missing — never a probe of what a company hires for.
  const foreign = await page.request.post('/api/cv/feedback', { data: { requisitionId: foreignReq } });
  expect(foreign.status()).toBe(404);
  expect((await foreign.json()).code).toBe('role_not_found');
  // The linked role passes every gate and stops at the provider (no key → 501), costing nothing.
  const usage = await prisma.aiUsage.count();
  for (const data of [{}, { requisitionId: linkedReq }]) {
    const res = await page.request.post('/api/cv/feedback', { data });
    expect(res.status()).toBe(501);
    const body = await res.json();
    expect(body.code).toBe('not_configured');
    expect(JSON.stringify(body)).not.toMatch(UPGRADE);
  }
  expect(await prisma.aiUsage.count()).toBe(usage);

  // Consent withdrawn: the consent gate, still no paywall.
  await prisma.userConsent.update({ where: { userId_type: { userId: pair.menteeId, type: 'AI_CV_PARSING' } }, data: { revokedAt: new Date() } });
  const noConsent = await page.request.post('/api/cv/feedback', { data: {} });
  expect(noConsent.status()).toBe(403);
  expect(JSON.stringify(await noConsent.json())).not.toMatch(UPGRADE);
});
