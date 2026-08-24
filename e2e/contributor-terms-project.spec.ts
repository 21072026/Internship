import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, acceptContributorTerms } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * Project-level contributor terms (#1026) — the middle link of the chain.
 *
 * Platform acceptance says "these are the rules here"; project acceptance says
 * "…and I accept them for THIS work", which is the part § 40 UrhG cares about.
 * So a member who has accepted at platform level is still gated on the project,
 * and the two acceptance rows are distinct.
 */

const PASSWORD = 'ProjTerms123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a member is gated on the project until they accept its terms', async ({ page }) => {
  const terms = await prisma.contributorTerms.findFirst({ where: { key: 'default' } });
  test.skip(!terms, 'no contributor terms seeded in this database');

  const adminEmail = uniqueEmail('pt-admin');
  const menteeEmail = uniqueEmail('pt-mentee');
  const admin = await seedUser(adminEmail, 'x', 'ADMIN', 'PT Admin');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'PT Mentee');
  // Accepted at PLATFORM level — which must not be mistaken for accepting the
  // project's terms. That confusion is exactly what this slice exists to avoid.
  await acceptContributorTerms(mentee.id);

  const project = await prisma.project.create({
    data: {
      name: 'PT Gated Project', ownerType: 'ADMIN', ownerUserId: admin.id, isPublic: false,
      members: { create: [{ userId: mentee.id, role: 'MENTEE', functionalRole: 'DEVELOPER' }] },
    },
  });
  const open = await prisma.project.create({
    data: {
      name: 'PT Open Project', ownerType: 'ADMIN', ownerUserId: admin.id, isPublic: false,
      // A project that genuinely has no IP question never asks.
      contributorTermsRequired: false,
      members: { create: [{ userId: mentee.id, role: 'MENTEE' }] },
    },
  });

  try {
    await signInAndSettle(page, menteeEmail, PASSWORD, '/portal');

    // The project that opted out is open straight away.
    await page.goto(`/projects/${open.id}`);
    await expect(page.getByTestId('project-terms-gate')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'PT Open Project' })).toBeVisible();

    // The one that asks shows the text instead of the internal view.
    await page.goto(`/projects/${project.id}`);
    const gate = page.getByTestId('project-terms-gate');
    await expect(gate).toBeVisible();
    await expect(gate.getByTestId('terms-body')).toBeVisible();
    await expect(page.getByTestId('project-internal')).toHaveCount(0);

    const box = page.getByTestId('terms-accept-checkbox');
    await expect(box).not.toBeChecked();
    const submit = page.getByTestId('terms-accept-submit');
    await expect(submit).toBeDisabled();
    await box.check();
    await submit.click();

    // Accepting reveals the internal view on the same URL.
    await expect(page.getByTestId('project-terms-gate')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('project-internal')).toBeVisible();

    // Two distinct rows: platform (projectId null) and this project.
    const rows = await prisma.contributorTermsAcceptance.findMany({ where: { userId: mentee.id } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.projectId === project.id)).toHaveLength(1);
    expect(rows.filter((r) => r.projectId === null)).toHaveLength(1);

    // A newer version raises the gate again — the project follows the document,
    // not one frozen version of it.
    const newer = await prisma.contributorTerms.create({
      data: {
        key: 'default', version: '9.9-e2e-project', locale: 'en', isAuthoritative: true,
        body: '# Contributor terms\n\nA newer version, for the project re-acceptance test.',
        effectiveFrom: new Date(Date.now() - 60_000),
      },
    });
    try {
      await page.goto(`/projects/${project.id}`);
      await expect(page.getByTestId('project-terms-gate')).toBeVisible();
    } finally {
      await prisma.contributorTerms.delete({ where: { id: newer.id } });
    }
  } finally {
    await prisma.contributorTermsAcceptance.deleteMany({ where: { userId: mentee.id } });
    await prisma.project.deleteMany({ where: { id: { in: [project.id, open.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('the acceptance API refuses a project the caller is not on', async ({ page }) => {
  const terms = await prisma.contributorTerms.findFirst({ where: { key: 'default' } });
  test.skip(!terms, 'no contributor terms seeded in this database');

  const adminEmail = uniqueEmail('pt-owner');
  const outsiderEmail = uniqueEmail('pt-outsider');
  const admin = await seedUser(adminEmail, 'x', 'ADMIN', 'PT Owner');
  await seedUser(outsiderEmail, PASSWORD, 'MENTEE', 'PT Outsider');
  const project = await prisma.project.create({
    data: { name: 'PT Foreign Project', ownerType: 'ADMIN', ownerUserId: admin.id, isPublic: false },
  });

  try {
    // A signed-in non-member is the case that matters: an acceptance row for a
    // project you are not on is evidence of nothing, which is worse than no
    // evidence at all.
    await signInAndSettle(page, outsiderEmail, PASSWORD, '/portal');
    const res = await page.request.post('/api/contributor-terms', {
      data: { version: terms!.version, projectId: project.id },
    });
    expect(res.status()).toBe(403);
    expect(await prisma.contributorTermsAcceptance.count({ where: { projectId: project.id } })).toBe(0);
  } finally {
    await prisma.contributorTermsAcceptance.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(outsiderEmail);
    await cleanupByEmail(adminEmail);
  }
});
