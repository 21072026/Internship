import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, acceptContributorTerms } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * The admin due-diligence report (#1027).
 *
 * The question it answers is "show me that every contributor agreed", so the
 * assertions are about the rows that say NO as much as the ones that say yes —
 * a report listing only acceptances answers the easy half.
 */

const PASSWORD = 'ReportAdmin123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the report shows an acceptance, flags who has not accepted, and filters', async ({ page }) => {
  const terms = await prisma.contributorTerms.findFirst({ where: { key: 'default' } });
  test.skip(!terms, 'no contributor terms seeded in this database');

  const adminEmail = uniqueEmail('ctr-admin');
  const yesEmail = uniqueEmail('ctr-yes');
  const noEmail = uniqueEmail('ctr-no');
  const oldEmail = uniqueEmail('ctr-old');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'CTR Admin');
  const yes = await seedUser(yesEmail, 'x', 'MENTEE', 'CTR Accepted Person');
  const no = await seedUser(noEmail, 'x', 'MENTEE', 'CTR Missing Person');
  const old = await seedUser(oldEmail, 'x', 'MENTEE', 'CTR Outdated Person');

  await acceptContributorTerms(yes.id);
  // Accepted a version that no longer governs — its own answer, not a shade of
  // "accepted", because a re-consent campaign has to be able to find these.
  await prisma.contributorTermsAcceptance.create({
    data: { userId: old.id, termsKey: 'default', version: '0.0-e2e-old', projectId: null, ipHash: 'a'.repeat(32) },
  });

  const project = await prisma.project.create({
    data: {
      name: `CTR Project ${Date.now()}`, ownerType: 'ADMIN', ownerUserId: admin.id, isPublic: false,
      members: { create: [{ userId: yes.id, role: 'MENTEE' }] },
    },
  });

  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
    await page.goto('/admin/contributor-terms');

    const table = page.getByTestId('terms-report-table');
    await expect(table).toBeVisible({ timeout: 15_000 });

    // Platform scope: one row each, with three different answers.
    const yesRow = page.getByTestId(`terms-report-row-${yes.id}-platform`);
    const noRow = page.getByTestId(`terms-report-row-${no.id}-platform`);
    const oldRow = page.getByTestId(`terms-report-row-${old.id}-platform`);
    await expect(yesRow).toContainText('Accepted');
    await expect(noRow).toContainText('Not accepted');
    await expect(oldRow).toContainText('Outdated version');
    // Evidence is reported as recorded, never as a value — the stored hash is
    // one more identifier and proves nothing to a reader.
    await expect(oldRow).toContainText('recorded');
    await expect(oldRow).not.toContainText('aaaa');

    // Being on a project adds a second, separately-answered row.
    const projectRow = page.getByTestId(`terms-report-row-${yes.id}-${project.id}`);
    await expect(projectRow).toContainText('Not accepted');

    // "Still owed" is the working filter: it drops the accepted rows and keeps
    // both kinds of outstanding one.
    await page.getByTestId('terms-report-status').selectOption('open');
    await expect(noRow).toBeVisible();
    await expect(oldRow).toBeVisible();
    await expect(yesRow).toHaveCount(0);

    // Narrowing to the project scope drops the platform rows.
    await page.getByTestId('terms-report-status').selectOption('all');
    await page.getByTestId('terms-report-project').selectOption(project.id);
    await expect(projectRow).toBeVisible();
    await expect(yesRow).toHaveCount(0);

    // The export control is there and live for a non-empty result.
    await expect(page.getByTestId('terms-report-export')).toBeEnabled();
  } finally {
    await prisma.contributorTermsAcceptance.deleteMany({ where: { userId: { in: [yes.id, no.id, old.id] } } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(oldEmail);
    await cleanupByEmail(noEmail);
    await cleanupByEmail(yesEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('the report is not reachable by a non-admin', async ({ page }) => {
  const menteeEmail = uniqueEmail('ctr-outsider');
  await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'CTR Outsider');
  try {
    await signInAndSettle(page, menteeEmail, PASSWORD, '/portal');
    await page.goto('/admin/contributor-terms');
    await expect(page).not.toHaveURL(/\/admin\/contributor-terms/);
    await expect(page.getByTestId('terms-report-table')).toHaveCount(0);
  } finally {
    await cleanupByEmail(menteeEmail);
  }
});
