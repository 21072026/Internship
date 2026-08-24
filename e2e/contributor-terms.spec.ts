import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * Contributor terms, platform-level acceptance (#1025).
 *
 * The assertions here are the legal properties, not the pixels: the text is
 * readable without signing in, the box starts unticked, the button is dead
 * until it is ticked, accepting writes an evidence row, and the contributor
 * surface unblocks — while the rest of the portal was never blocked at all.
 */

const PASSWORD = 'TestPass123!';
const TERMS_KEY = 'default';

let menteeEmail: string;
let menteeId: string;

test.beforeAll(async () => {
  menteeEmail = uniqueEmail('terms-mentee');
  const user = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Terms Mentee');
  menteeId = user.id;
});

test.afterAll(async () => {
  await prisma.contributorTermsAcceptance.deleteMany({ where: { userId: menteeId } });
  await cleanupByEmail(menteeEmail);
  await prisma.$disconnect();
});

test('the terms are readable without signing in', async ({ page }) => {
  const terms = await prisma.contributorTerms.findFirst({ where: { key: TERMS_KEY } });
  test.skip(!terms, 'no contributor terms seeded in this database');

  await page.goto('/contributor-terms');
  await expect(page).toHaveURL(/\/contributor-terms/);
  await expect(page.getByTestId('terms-body')).toBeVisible();
  // Signed out there is no accept box and no history — only the text.
  await expect(page.getByTestId('terms-accept')).toHaveCount(0);
  await expect(page.getByTestId('terms-history')).toHaveCount(0);
});

test('the gate gives way to an unticked box, and accepting unblocks the contributor surface', async ({ page }) => {
  const terms = await prisma.contributorTerms.findFirst({
    where: { key: TERMS_KEY },
    orderBy: { effectiveFrom: 'desc' },
  });
  test.skip(!terms, 'no contributor terms seeded in this database');

  await prisma.contributorTermsAcceptance.deleteMany({ where: { userId: menteeId } });
  await signInAndSettle(page, menteeEmail, PASSWORD, '/portal');

  // Ordinary portal use is NOT gated — that is the scope line in #1025.
  await page.goto('/portal/profile');
  await expect(page.getByTestId('contributor-terms-gate')).toHaveCount(0);

  // The contributor surface is.
  await page.goto('/portal/projects');
  const gate = page.getByTestId('contributor-terms-gate');
  await expect(gate).toBeVisible();
  await page.getByTestId('contributor-terms-gate-cta').click();
  await page.waitForURL(/\/onboarding\/contributor-terms/);

  // Text first, then an UNTICKED box, and no way to accept until it is ticked.
  await expect(page.getByTestId('terms-body')).toBeVisible();
  const box = page.getByTestId('terms-accept-checkbox');
  await expect(box).not.toBeChecked();
  const submit = page.getByTestId('terms-accept-submit');
  await expect(submit).toBeDisabled();

  await box.check();
  await expect(submit).toBeEnabled();
  await submit.click();

  // Back on the surface the gate was standing in front of, now unblocked.
  await page.waitForURL(/\/portal\/projects/);
  await expect(page.getByTestId('contributor-terms-gate')).toHaveCount(0);

  // And an evidence row exists: who, which version, hashed client — never a raw IP.
  const row = await prisma.contributorTermsAcceptance.findFirst({ where: { userId: menteeId } });
  expect(row).toBeTruthy();
  expect(row!.version).toBe(terms!.version);
  expect(row!.projectId).toBeNull();
  expect(row!.ipHash === null || /^[0-9a-f]{32}$/.test(row!.ipHash)).toBe(true);

  // The permanent copy shows it back.
  await page.goto('/contributor-terms');
  await expect(page.getByTestId('terms-history')).toContainText(`${TERMS_KEY} v${terms!.version}`);
  await expect(page.getByTestId('terms-accept')).toHaveCount(0);
});

test('a new version asks again', async ({ page }) => {
  const current = await prisma.contributorTerms.findFirst({
    where: { key: TERMS_KEY },
    orderBy: { effectiveFrom: 'desc' },
  });
  test.skip(!current, 'no contributor terms seeded in this database');

  // Accepting v1.0 says nothing about v9.9 — that is what versioning is for.
  await prisma.contributorTermsAcceptance.deleteMany({ where: { userId: menteeId } });
  await prisma.contributorTermsAcceptance.create({
    data: { userId: menteeId, termsKey: TERMS_KEY, version: current!.version, projectId: null },
  });

  const newer = await prisma.contributorTerms.create({
    data: {
      key: TERMS_KEY,
      version: '9.9-e2e',
      locale: 'en',
      isAuthoritative: true,
      body: '# Contributor terms\n\nA newer version, for the re-acceptance test.',
      effectiveFrom: new Date(Date.now() - 60_000),
    },
  });

  try {
    await signInAndSettle(page, menteeEmail, PASSWORD, '/portal');
    await page.goto('/portal/projects');
    await expect(page.getByTestId('contributor-terms-gate')).toBeVisible();
  } finally {
    await prisma.contributorTerms.delete({ where: { id: newer.id } });
    await prisma.contributorTermsAcceptance.deleteMany({ where: { userId: menteeId } });
  }
});
