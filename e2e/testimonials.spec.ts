import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Consent-based testimonials (#1096/#1098/#1100): nothing is publishable
// without BOTH sides' TESTIMONIAL consent, nothing is published without the
// author approving the exact wording, the original comment never changes,
// revoking unpublishes in the same request, and the public surfaces carry no
// PII beyond the approved excerpt + a formatted name.
const PASSWORD = 'Testi123!pass';
const SECRET_COMMENT = 'SECRET-FULL-COMMENT with private context about Acme GmbH';
const EXCERPT = 'A wonderful mentorship excerpt for the world to see';

const adminEmail = uniqueEmail('testi-admin');
const mentorEmail = uniqueEmail('testi-mentor');
const menteeEmail = uniqueEmail('testi-mentee');
let adminId = '';
let mentorId = '';
let menteeId = '';
let relationId = '';
let evaluationId = '';

test.describe.configure({ mode: 'serial' });

async function signIn(page: import('@playwright/test').Page, email: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

async function grantConsent(userId: string) {
  await prisma.userConsent.upsert({
    where: { userId_type: { userId, type: 'TESTIMONIAL' } },
    create: { userId, type: 'TESTIMONIAL', grantedAt: new Date() },
    update: { grantedAt: new Date(), revokedAt: null },
  });
}

test.beforeAll(async () => {
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Testi Admin');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Story Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Story Mentee');
  adminId = admin.id;
  mentorId = mentor.id;
  menteeId = mentee.id;
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId, menteeId } });
  relationId = rel.id;
  const ev = await prisma.evaluation.create({
    data: { relationId, authorId: mentorId, scores: { technical: 5 }, comment: SECRET_COMMENT },
  });
  evaluationId = ev.id;
});

test.afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [adminId, mentorId, menteeId] } } });
  await prisma.evaluation.deleteMany({ where: { relationId } });
  await prisma.mentorshipRelation.deleteMany({ where: { id: relationId } });
  await cleanupByEmail(menteeEmail);
  await cleanupByEmail(mentorEmail);
  await cleanupByEmail(adminEmail);
  await prisma.$disconnect();
});

test('the moderation pool never shows an evaluation without BOTH consents (#1096/#1098)', async ({ page }) => {
  await signIn(page, adminEmail, '/admin');

  // No consents at all → not even the admin sees it.
  let res = await page.request.get('/api/admin/testimonials');
  expect(res.status()).toBe(200);
  let ids = ((await res.json()).testimonials as { id: string }[]).map((t) => t.id);
  expect(ids).not.toContain(evaluationId);

  // Author only → still hidden (the subject has not consented).
  await grantConsent(mentorId);
  res = await page.request.get('/api/admin/testimonials');
  ids = ((await res.json()).testimonials as { id: string }[]).map((t) => t.id);
  expect(ids).not.toContain(evaluationId);

  // Both sides → it appears.
  await grantConsent(menteeId);
  res = await page.request.get('/api/admin/testimonials');
  ids = ((await res.json()).testimonials as { id: string }[]).map((t) => t.id);
  expect(ids).toContain(evaluationId);

  // Non-admins get nothing from any moderation endpoint.
  const menteePage = await page.context().browser()!.newContext();
  const anon = await menteePage.request.get('/api/admin/testimonials');
  expect(anon.status()).toBe(401);
  await menteePage.close();
});

test('two-person publish: admin drafts, publish blocked until the author approves the exact wording (#1098)', async ({ page }) => {
  await signIn(page, adminEmail, '/admin');

  // Draft the excerpt → author gets the approval notification.
  const draft = await page.request.patch('/api/admin/testimonials', {
    data: { evaluationId, action: 'saveExcerpt', excerpt: EXCERPT },
  });
  expect(draft.status()).toBe(200);
  await expect
    .poll(async () => prisma.notification.count({ where: { userId: mentorId, type: 'testimonial.approvalRequested' } }))
    .toBe(1);

  // Publishing before approval is refused server-side.
  const early = await page.request.patch('/api/admin/testimonials', {
    data: { evaluationId, action: 'publish' },
  });
  expect(early.status()).toBe(400);
  expect((await early.json()).code).toBe('not_approved');

  // The original comment is untouched by drafting.
  const ev = await prisma.evaluation.findUniqueOrThrow({ where: { id: evaluationId } });
  expect(ev.comment).toBe(SECRET_COMMENT);
});

test('author approves; admin publishes; the public surfaces carry the excerpt and no PII (#1098/#1100)', async ({ page }) => {
  // Author approves the exact wording.
  await signIn(page, mentorEmail, '/mentor');
  await page.goto('/testimonials/approve');
  await page.getByTestId(`testimonial-approve-yes-${evaluationId}`).click();
  await expect
    .poll(async () => (await prisma.evaluation.findUniqueOrThrow({ where: { id: evaluationId } })).excerptApprovedAt)
    .not.toBeNull();

  // Admin publishes via the API (same call the UI makes).
  const adminCtx = await page.context().browser()!.newContext();
  const adminPage = await adminCtx.newPage();
  await signIn(adminPage, adminEmail, '/admin');
  const pub = await adminPage.request.patch('/api/admin/testimonials', {
    data: { evaluationId, action: 'publish' },
  });
  expect(pub.status()).toBe(200);
  await adminCtx.close();

  // Public feed: four gates passed → the excerpt, initials-formatted name, no PII.
  const res = await page.request.get('/api/public/stories');
  expect(res.status()).toBe(200);
  const raw = await res.text();
  expect(raw).toContain(EXCERPT);
  expect(raw).not.toContain(SECRET_COMMENT);
  expect(raw).not.toContain('scores');
  expect(raw).not.toContain(mentorEmail);
  // Default name style is initials — the full name never leaks by default.
  expect(raw).not.toContain('Story Mentor');
  expect(raw).toContain('S. M.');
});

test('/stories and the landing section render only while a story is published (#1100)', async ({ page }) => {
  // Anonymous visitor — the landing redirect only applies to signed-in users.
  await page.goto('/stories');
  await expect(page.getByTestId('stories-list')).toBeVisible();
  await expect(page.getByText(EXCERPT)).toBeVisible();

  await page.goto('/');
  await expect(page.getByTestId('landing-stories')).toBeVisible();

  // The subject revokes their consent → unpublished in the same request.
  const menteeCtx = await page.context().browser()!.newContext();
  const menteePage = await menteeCtx.newPage();
  await signIn(menteePage, menteeEmail, '/portal');
  const revoke = await menteePage.request.post('/api/consent', {
    data: { type: 'TESTIMONIAL', granted: false },
  });
  expect(revoke.status()).toBe(200);
  await menteeCtx.close();

  const ev = await prisma.evaluation.findUniqueOrThrow({ where: { id: evaluationId } });
  expect(ev.publishedAt).toBeNull();
  expect(ev.sharedPublicly).toBe(false);

  // Public surfaces are empty again: feed empty, /stories 404, landing section gone.
  const res = await page.request.get('/api/public/stories');
  expect(((await res.json()).stories as unknown[]).length).toBe(0);
  const storiesPage = await page.goto('/stories');
  expect(storiesPage!.status()).toBe(404);
  await page.goto('/');
  await expect(page.getByTestId('landing-stories')).toHaveCount(0);
});
