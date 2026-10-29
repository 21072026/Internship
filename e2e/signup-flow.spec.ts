// Self-serve signup, the client half (#1751): the /signup page in three
// languages, the "check your email" state, and a brand-new tenant's /admin
// showing the three-step first-run panel until its first pairing. The e2e
// server runs with SELF_SERVE_SIGNUP=true; the flag-off "opening soon" state is
// pinned by scripts/test/self-serve-signup.test.mjs.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { prisma, cleanupByEmail, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

const PASSWORD = 'SelfServe-Flow-2026!';
const emails: string[] = [];
const orgIds: string[] = [];

test.afterAll(async () => {
  for (const id of orgIds) {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: id } });
  }
  for (const e of emails) await cleanupByEmail(e);
  for (const id of orgIds) {
    await prisma.invitationToken.deleteMany({ where: { orgId: id } });
    await prisma.evaluationTemplate.deleteMany({ where: { orgId: id } });
    await prisma.projectTaskTemplate.deleteMany({ where: { orgId: id } });
    await prisma.user.deleteMany({ where: { orgId: id } });
    await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  }
});

for (const [locale, title, freeCore] of [
  ['en', 'Start your mentoring programme', 'Mentors and mentees are always free'],
  ['tr', 'Mentorluk programınızı başlatın', 'Mentorlar ve menteeler her zaman ücretsiz'],
  ['de', 'Starten Sie Ihr Mentoring-Programm', 'Mentoren und Mentees sind immer kostenlos'],
] as const) {
  test(`/signup renders in ${locale} with the Community terms and the free-core line`, async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: 'locale', value: locale, url: baseURL! }]);
    await gotoSettled(page, '/signup');
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    const terms = page.getByTestId('signup-community-terms');
    await expect(terms).toContainText(freeCore);
    await expect(terms).toContainText('25');
    await expect(page.getByTestId('signup-form')).toBeVisible();
    await expect(page.getByTestId('signup-opening-soon')).toHaveCount(0);
  });
}

test('the public chrome and the Community column lead to /signup while the flag is on', async ({ page }) => {
  await gotoSettled(page, '/pricing');
  await expect(page.getByTestId('plan-cta-community')).toHaveAttribute('href', '/signup');
  await expect(page.getByTestId('public-nav-start-free')).toHaveAttribute('href', '/signup');
});

test('signup → check your email → verify → the new admin sees the first-run panel until the first pairing', async ({ page }) => {
  const email = uniqueEmail('selfserve-flow');
  emails.push(email);
  await page.context().setExtraHTTPHeaders(freshIp('signup-flow'));

  await gotoSettled(page, '/signup');
  const form = page.getByTestId('signup-form');
  await form.locator('input[name="orgName"]').fill(`Acme Mentoring ${Date.now()}`);
  await form.locator('input[name="fullName"]').fill('Flow Admin');
  await form.locator('input[name="email"]').fill(email);
  await form.locator('input[name="password"]').fill(PASSWORD);
  await form.locator('input[name="consent"]').check();
  await form.getByRole('button', { name: 'Create my organization' }).click();

  // Never a session: the page says "check your email" and nothing else.
  await expect(page.getByTestId('signup-check-email')).toContainText(email);
  const admin = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true, orgId: true, isActive: true } });
  expect(admin.isActive).toBe(false);
  orgIds.push(admin.orgId!);

  const token = await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: admin.id, used: false }, orderBy: { createdAt: 'desc' } });
  expect((await page.request.post('/api/auth/verify-email', { data: { token: token.token } })).ok()).toBeTruthy();

  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

  // The panel writes nothing: the org's rows are the same before and after.
  const rowsBefore = await Promise.all([
    prisma.user.count({ where: { orgId: admin.orgId } }),
    prisma.invitationToken.count({ where: { orgId: admin.orgId } }),
    prisma.mentorshipRelation.count({ where: { orgId: admin.orgId } }),
  ]);
  await gotoSettled(page, '/admin');
  const panel = page.getByTestId('first-run-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('first-run-step-1')).toHaveAttribute('href', '/admin/invite?role=MENTOR');
  await expect(page.getByTestId('first-run-step-2')).toHaveAttribute('href', '/admin/invite?role=MENTEE');
  await expect(page.getByTestId('first-run-step-3')).toHaveAttribute('href', '/admin/mentorship');
  await expect(page.getByTestId('first-run-community')).toContainText('25');
  const axe = await new AxeBuilder({ page }).include('[data-testid="first-run-panel"]').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  expect(
    await Promise.all([
      prisma.user.count({ where: { orgId: admin.orgId } }),
      prisma.invitationToken.count({ where: { orgId: admin.orgId } }),
      prisma.mentorshipRelation.count({ where: { orgId: admin.orgId } }),
    ]),
  ).toEqual(rowsBefore);

  // The first step's link preselects the mentor role.
  await page.getByTestId('first-run-step-1').click();
  await page.waitForURL(/\/admin\/invite\?role=MENTOR/);
  await expect(page.locator('select[name="role"]')).toHaveValue('MENTOR');

  // The first pairing makes the panel disappear.
  const mentorEmail = uniqueEmail('selfserve-flow-mentor');
  const menteeEmail = uniqueEmail('selfserve-flow-mentee');
  emails.push(mentorEmail, menteeEmail);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Flow Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Flow Mentee');
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id] } }, data: { orgId: admin.orgId } });
  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, orgId: admin.orgId } });
  await gotoSettled(page, '/admin');
  await expect(page.getByText('Mentees per stage').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByTestId('first-run-panel')).toHaveCount(0);
});
