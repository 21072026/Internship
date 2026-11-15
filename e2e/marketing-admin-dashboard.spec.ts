import { test, expect, type Page } from '@playwright/test';
import { prisma } from './helpers/db';
import { gotoSettled } from './helpers/auth';
import { seedTwoTenants, signInAsTenantActor, type TwoTenants } from './helpers/tenants';

/**
 * The MARKETING admin dashboard has no dead links (#2348, #2578).
 *
 * `/admin/mentors` and `/admin/mentorship` are mentorship segments, which
 * gatePage closes in a vertical without the module — a MARKETING admin who
 * clicked the reps card, the deals card, "view all" or the onboarding
 * checklist's pairing steps got a 404. Every link under <main> on /admin is
 * collected here, with seeded data so the conditional ones render too (the
 * recent-deals rows and their "view all", a new lead, the overdue badge, the
 * checklist), and each must open a page.
 *
 * Tenant A is MARKETING, tenant B INTERNSHIP: B is the no-op control that its
 * dashboard and checklist still point where they always did.
 */

let tenants: TwoTenants;

test.beforeAll(async () => {
  tenants = await seedTwoTenants({ verticalA: 'MARKETING', verticalB: 'INTERNSHIP' });
  // An overdue stage on each tenant's relation, so `dashboard-overdue` renders.
  for (const t of [tenants.orgA, tenants.orgB]) {
    await prisma.mentorshipRelation.update({
      where: { id: t.relation.id },
      data: { stageDeadline: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    });
  }
});

test.afterAll(async () => {
  await tenants?.cleanup();
  await prisma.$disconnect();
});

/** Every same-app href under <main>, once each, after the checklist has loaded. */
async function dashboardLinks(page: Page): Promise<string[]> {
  await gotoSettled(page, '/admin');
  await expect(page.getByTestId('onboarding-checklist')).toBeVisible();
  await expect(page.getByTestId('dashboard-overdue')).toBeVisible();
  const hrefs = await page.locator('main a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
  return [...new Set(hrefs.filter((h) => h.startsWith('/')))].sort();
}

test('every link on the MARKETING admin dashboard opens a page', { tag: '@smoke' }, async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgA.admin);
  const links = await dashboardLinks(page);

  // The conditional links really rendered — otherwise the sweep proves little.
  expect(links).toContain('/admin/board');
  expect(links).toContain('/admin/users');
  expect(links).toContain(`/admin/candidates/${tenants.orgA.mentee.id}`);
  // And the mentorship segments are not linked at all.
  expect(links.filter((h) => /^\/admin\/(mentors|mentorship)(\/|\?|$)/.test(h))).toEqual([]);

  for (const href of links) {
    const res = await page.request.get(href);
    expect(res.status(), `${href} must open a page for a MARKETING admin`).toBeLessThan(400);
  }

  // The checklist speaks sales and has no evaluation step (no `evaluations` module).
  await expect(page.getByTestId('onboarding-step-assignMentorship')).toHaveAttribute('href', '/admin/board');
  await expect(page.getByTestId('onboarding-step-evaluationTemplate')).toHaveCount(0);
  await expect(page.getByTestId('onboarding-checklist')).toContainText('Create the first deal');
});

/** Open the hover card of the rep/mentor on the recent-deals row and return its profile link. */
async function mentorCardProfile(page: Page, mentorName: string) {
  await gotoSettled(page, '/admin');
  await page.getByRole('button', { name: mentorName }).first().hover();
  const card = page.getByTestId('person-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('person-card-message')).toBeVisible(); // the record has loaded
  return card.getByTestId('person-card-profile');
}

test('the rep hover card on the MARKETING dashboard offers no dead profile link', { tag: '@smoke' }, async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgA.admin);
  // /admin/mentors/<id> is closed in this vertical and there is no per-user
  // admin page, so the card offers no profile link at all (#2348).
  await expect(await mentorCardProfile(page, tenants.orgA.mentor.fullName)).toHaveCount(0);
  for (const href of await page.locator('[data-testid="person-card"] a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))) {
    if (!href.startsWith('/')) continue;
    expect((await page.request.get(href)).status(), `${href} from the hover card`).toBeLessThan(400);
  }
});

test('control: the INTERNSHIP mentor hover card still opens the mentor page', { tag: '@smoke' }, async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgB.admin);
  await expect(await mentorCardProfile(page, tenants.orgB.mentor.fullName)).toHaveAttribute('href', `/admin/mentors/${tenants.orgB.mentor.id}`);
});

test('control: the INTERNSHIP dashboard and checklist are unchanged', { tag: '@smoke' }, async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgB.admin);
  const links = await dashboardLinks(page);
  expect(links).toContain('/admin/mentors');
  expect(links).toContain('/admin/mentorship');
  expect(links).not.toContain('/admin/board');
  await expect(page.getByTestId('onboarding-step-assignMentorship')).toHaveAttribute('href', '/admin/mentorship');
  await expect(page.getByTestId('onboarding-step-evaluationTemplate')).toHaveCount(1);
});
