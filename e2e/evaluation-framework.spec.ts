import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// #822 — evaluation criteria as org data instead of hardcoded arrays.
//
// The non-negotiable acceptance criterion is the first test: an org that
// defines no template keeps EXACTLY today's four criteria and today's
// behaviour. The rest prove the configured path works and that history does
// not rot when the framework changes underneath it.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// A framework belongs to an org, so the pair has to live in the SAME org as the
// admin who configures it — seedUser leaves orgId null, which would otherwise
// resolve to the built-ins no matter what the admin saved.
async function seedPair(prefix: string) {
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const orgId = admin?.orgId ?? null;
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Rubric Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Rubric Mentee');
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id] } }, data: { orgId } });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId, status: 'ACTIVE' },
  });
  return { mentorEmail, menteeEmail, mentor, mentee, relation, orgId };
}

test('an org that defines no framework keeps the built-in four criteria, unchanged', async ({ page }) => {
  test.slow();
  // Its own org on purpose: this is the "installation that never touched the
  // framework" case, and it must hold regardless of what any other test left
  // behind in the admin's org.
  const org = await prisma.organization.create({
    data: { name: 'E2E Rubric Default', slug: uniqueEmail('rubric-org').split('@')[0] },
  });
  const mentorEmail = uniqueEmail('rubric-default-mentor');
  const menteeEmail = uniqueEmail('rubric-default-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Rubric Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Rubric Mentee');
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id] } }, data: { orgId: org.id } });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: org.id, status: 'ACTIVE' },
  });
  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');

    // The built-in rubric still validates and still stores what it always did.
    const res = await page.request.post('/api/evaluations', {
      data: {
        relationId: relation.id,
        scores: { technical: 4, communication: 5, reliability: 3, growth: 4 },
        comment: 'Built-in rubric',
      },
    });
    expect(res.status()).toBe(201);
    const created = await prisma.evaluation.findFirst({ where: { relationId: relation.id } });
    // No template stamped: this org uses the built-ins, exactly like every
    // record written before #822.
    expect(created?.templateId).toBeNull();

    // And the form on screen still asks for those four.
    await page.goto(`/mentor/mentees/${relation.id}`);
    for (const label of ['Technical', 'Communication', 'Reliability', 'Growth']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    }
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('an admin defines the org’s own criteria; they replace the built-ins and are what gets stored', async ({ page }) => {
  test.slow();
  const { mentorEmail, menteeEmail, relation, orgId } = await seedPair('rubric-custom');
  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    const saved = await page.request.put('/api/admin/evaluation-templates', {
      data: {
        scope: 'MENTEE',
        criteria: [
          { key: 'ownership', labels: { en: 'Ownership', tr: 'Sahiplenme', de: 'Verantwortung' } },
          { key: 'craft', labels: { en: 'Craft', tr: 'Ustalık', de: 'Handwerk' } },
        ],
      },
    });
    expect(saved.ok()).toBeTruthy();

    // The built-in keys are still accepted (a form rendered a moment earlier
    // must not fail on submit), but the org's own keys are what the form asks
    // for and what a new record is stamped with.
    //
    // Switching identity on the SAME page while still authenticated as admin
    // needs the "different user" helper (see helpers/auth.ts): plain
    // signInAndSettle's goto('/auth/signin') can land while the outgoing
    // page's session cookie is still being re-issued, so /auth/signin sees
    // `authenticated` and router.replace()s to /admin mid-fill, detaching the
    // submit button Playwright is about to click.
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');
    const res = await page.request.post('/api/evaluations', {
      data: { relationId: relation.id, scores: { ownership: 5, craft: 4 } },
    });
    expect(res.status()).toBe(201);
    const created = await prisma.evaluation.findFirst({ where: { relationId: relation.id } });
    expect(created?.templateId).not.toBeNull();

    // A key belonging to no rubric in this org is refused.
    const bad = await page.request.post('/api/evaluations', {
      data: { relationId: relation.id, scores: { notACriterion: 3 } },
    });
    expect(bad.status()).toBe(400);

    await page.goto(`/mentor/mentees/${relation.id}`);
    await expect(page.getByText('Ownership', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Craft', { exact: true }).first()).toBeVisible();
    // The built-ins are gone from the form.
    await expect(page.getByText('Technical', { exact: true })).toHaveCount(0);
  } finally {
    if (orgId) {
      await prisma.evaluationCriterion.deleteMany({ where: { template: { orgId } } });
      await prisma.evaluationTemplate.deleteMany({ where: { orgId } });
    }
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('retiring a criterion keeps it readable on the evaluations that were scored with it', async ({ page }) => {
  test.slow();
  const { mentorEmail, menteeEmail, relation, orgId } = await seedPair('rubric-history');
  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    await page.request.put('/api/admin/evaluation-templates', {
      data: { scope: 'MENTEE', criteria: [{ key: 'punctuality', labels: { en: 'Punctuality' } }] },
    });

    // Switching identity on the SAME page while still authenticated needs the
    // "different user" helper for every re-login below (see helpers/auth.ts):
    // plain signInAndSettle's goto('/auth/signin') can land while the
    // outgoing page's session cookie is still being re-issued, so
    // /auth/signin sees `authenticated` and router.replace()s to the previous
    // user's dashboard mid-fill, detaching the submit button Playwright is
    // about to click.
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');
    const res = await page.request.post('/api/evaluations', {
      data: { relationId: relation.id, scores: { punctuality: 5 } },
    });
    expect(res.status()).toBe(201);

    // The org rewrites its framework — the old criterion is retired, not
    // deleted, so the record it scored keeps its label.
    await signInAsFreshUser(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    await page.request.put('/api/admin/evaluation-templates', {
      data: { scope: 'MENTEE', criteria: [{ key: 'impact', labels: { en: 'Impact' } }] },
    });
    const retired = await prisma.evaluationCriterion.findFirst({ where: { key: 'punctuality', template: { orgId: orgId! } } });
    expect(retired).not.toBeNull();
    expect(retired?.active).toBe(false);

    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');
    await page.goto(`/mentor/mentees/${relation.id}`);
    // Asked for today: Impact. Still readable from the past: Punctuality.
    await expect(page.getByText('Impact', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Punctuality: ?5\/5/).first()).toBeVisible();
  } finally {
    if (orgId) {
      await prisma.evaluationCriterion.deleteMany({ where: { template: { orgId } } });
      await prisma.evaluationTemplate.deleteMany({ where: { orgId } });
    }
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
