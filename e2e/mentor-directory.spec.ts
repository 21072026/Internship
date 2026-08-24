import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #938 — mentee-facing /mentors directory (story #900). Listing requires BOTH
// publicProfile=true AND an active MENTOR_DIRECTORY_VISIBILITY consent; the
// API response must never contain contact details (email/phone/whatsapp).

const suffix = `${Date.now()}`;
const SKILL_A = `ReactDirE2E${suffix}`;
const SKILL_B = `VueDirE2E${suffix}`;

async function signIn(page: Page, email: string, password: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

test.describe('mentor directory', () => {
  const menteeEmail = uniqueEmail('dir-mentee');
  const consentedEmail = uniqueEmail('dir-consented');
  const unconsentedEmail = uniqueEmail('dir-unconsented');
  const pausedEmail = uniqueEmail('dir-paused');
  const companyEmail = uniqueEmail('dir-company');
  const pw = 'DirPass1234';

  let consentedId = '';
  let unconsentedId = '';
  let pausedId = '';

  test.beforeAll(async () => {
    await seedUser(menteeEmail, pw, 'MENTEE', 'Directory Mentee');
    await seedUser(companyEmail, pw, 'COMPANY', 'Directory Company');

    // Public profile + active consent → listed.
    const consented = await seedUser(consentedEmail, pw, 'MENTOR', 'Consented Dir Mentor');
    consentedId = consented.id;
    await prisma.user.update({
      where: { id: consented.id },
      data: {
        publicProfile: true,
        skills: [SKILL_A],
        languages: ['Turkish', 'English'],
        bio: 'Happy to help with frontend careers.',
        acceptingMentees: true,
      },
    });
    await prisma.userConsent.create({
      data: { userId: consented.id, type: 'MENTOR_DIRECTORY_VISIBILITY', grantedAt: new Date() },
    });

    // Public profile but NO consent → must never be listed.
    const unconsented = await seedUser(unconsentedEmail, pw, 'MENTOR', 'Unconsented Dir Mentor');
    unconsentedId = unconsented.id;
    await prisma.user.update({
      where: { id: unconsented.id },
      data: { publicProfile: true, skills: [SKILL_B], languages: ['German'] },
    });

    // Consented but not accepting → listed, filtered out by accepting=1.
    const paused = await seedUser(pausedEmail, pw, 'MENTOR', 'Paused Dir Mentor');
    pausedId = paused.id;
    await prisma.user.update({
      where: { id: paused.id },
      data: { publicProfile: true, skills: [SKILL_A], acceptingMentees: false },
    });
    await prisma.userConsent.create({
      data: { userId: paused.id, type: 'MENTOR_DIRECTORY_VISIBILITY', grantedAt: new Date() },
    });
  });

  test.afterAll(async () => {
    for (const email of [menteeEmail, consentedEmail, unconsentedEmail, pausedEmail, companyEmail]) {
      await cleanupByEmail(email);
    }
  });

  test('mentee sees only consented mentors; the response never leaks contact details', async ({ page }) => {
    await signIn(page, menteeEmail, pw, '/portal');

    await page.goto('/mentors');
    await expect(page.getByTestId(`mentor-card-${consentedId}`)).toBeVisible();
    await expect(page.getByTestId(`mentor-card-${unconsentedId}`)).toHaveCount(0);

    // Even a skill filter matching ONLY the unconsented mentor must not
    // surface them — the consent gate applies before any filtering.
    const noConsent = await page.request.get(`/api/mentors?skill=${SKILL_B}`);
    expect(noConsent.ok()).toBeTruthy();
    const noConsentBody = await noConsent.json();
    expect((noConsentBody.mentors as { id: string }[]).map((m) => m.id)).not.toContain(unconsentedId);

    // Allowlist check: no contact-detail key anywhere in the raw JSON.
    const raw = await page.request.get('/api/mentors');
    expect(raw.ok()).toBeTruthy();
    const rawText = JSON.stringify(await raw.json());
    expect(rawText).not.toContain('"email"');
    expect(rawText).not.toContain('"phone"');
    expect(rawText).not.toContain('"whatsapp"');
  });

  test('skill and accepting filters narrow the list', async ({ page }) => {
    await signIn(page, menteeEmail, pw, '/portal');
    await page.goto('/mentors');
    await expect(page.getByTestId(`mentor-card-${consentedId}`)).toBeVisible();

    // A skill only the unconsented mentor has → no matches at all.
    await page.getByTestId('mentors-filter-skill').fill(SKILL_B);
    await expect(page.getByTestId(`mentor-card-${consentedId}`)).toHaveCount(0);
    await expect(page.getByText('No mentors match these filters.')).toBeVisible();

    // The consented mentors' skill → both listed (accepting and paused).
    await page.getByTestId('mentors-filter-skill').fill(SKILL_A);
    await expect(page.getByTestId(`mentor-card-${consentedId}`)).toBeVisible();
    await expect(page.getByTestId(`mentor-card-${pausedId}`)).toBeVisible();

    // accepting=1 keeps the accepting mentor and drops the paused one.
    await page.getByTestId('mentors-filter-accepting').check();
    await expect(page.getByTestId(`mentor-card-${pausedId}`)).toHaveCount(0);
    await expect(page.getByTestId(`mentor-card-${consentedId}`)).toBeVisible();
  });

  test('revoking the consent removes the mentor from the directory immediately', async ({ page }) => {
    await signIn(page, menteeEmail, pw, '/portal');
    await page.goto('/mentors');
    await expect(page.getByTestId(`mentor-card-${consentedId}`)).toBeVisible();

    await prisma.userConsent.update({
      where: { userId_type: { userId: consentedId, type: 'MENTOR_DIRECTORY_VISIBILITY' } },
      data: { revokedAt: new Date() },
    });
    try {
      await page.reload();
      await expect(page.getByTestId('mentors-filter-skill')).toBeVisible();
      await expect(page.getByTestId(`mentor-card-${consentedId}`)).toHaveCount(0);

      const res = await page.request.get('/api/mentors');
      const ids = ((await res.json()).mentors as { id: string }[]).map((m) => m.id);
      expect(ids).not.toContain(consentedId);
    } finally {
      // Restore for any test ordering that follows.
      await prisma.userConsent.update({
        where: { userId_type: { userId: consentedId, type: 'MENTOR_DIRECTORY_VISIBILITY' } },
        data: { revokedAt: null },
      });
    }
  });

  test('COMPANY users get 403 from the API and are bounced off the page', async ({ page }) => {
    await signIn(page, companyEmail, pw, '/company');

    const res = await page.request.get('/api/mentors');
    expect(res.status()).toBe(403);

    // The page-level gate sends them back to their own home.
    await page.goto('/mentors');
    await page.waitForURL((u) => u.pathname.startsWith('/company'), { timeout: 20_000 });
  });
});
