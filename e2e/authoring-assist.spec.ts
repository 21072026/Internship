import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle, gotoSettled, signInViaApi } from './helpers/auth';

// Authoring assist and paste-in enrichment (#2055, part 2). CI has no provider
// key: the real endpoints are asserted for their gates (role, consent) and the
// 501 they end at; the UI tests stand in for the provider with page.route() and
// test what the app does with a reply — a draft fills only an EMPTY editor and
// is marked, and a proposal reaches the form only field by field, never saved.

const PW = 'AuthoringAssist123!';
const adminEmail = uniqueEmail('aa-admin');
const mentorEmail = uniqueEmail('aa-mentor');
const menteeEmail = uniqueEmail('aa-mentee');

test.beforeAll(async () => {
  // The admin assists are operator tasks behind the AI pack (#1738); this
  // spec's admin lives in the shared default org, which keeps the pack for the
  // whole run (never removed: other specs run on it in parallel). The locked
  // org is e2e/ai-entitlement.spec.ts's business.
  await setOrgFeature(null, 'AI_PACKAGE', true);
  await seedUser(adminEmail, PW, 'ADMIN', 'AA Admin');
  await seedUser(mentorEmail, PW, 'MENTOR', 'AA Mentor');
  await seedUser(menteeEmail, PW, 'MENTEE', 'AA Mentee');
});

test.afterAll(async () => {
  for (const e of [adminEmail, mentorEmail, menteeEmail]) await cleanupByEmail(e);
});

test('every assist endpoint is gated by role (and consent), and ends at 501 without a provider', async ({ playwright }, info) => {
  const baseURL = info.project.use.baseURL;
  const ctx = async (email: string) => {
    const c = await playwright.request.newContext({ baseURL });
    expect((await signInViaApi(c, email, PW)).ok).toBe(true);
    return c;
  };
  const [admin, mentor, mentee] = await Promise.all([ctx(adminEmail), ctx(mentorEmail), ctx(menteeEmail)]);
  const pasted = 'Ten years of backend work in fintech, Kotlin and Postgres, I run the internal mentoring circle.';
  try {
    expect((await mentor.post('/api/admin/ai/draft', { data: { purpose: 'announcement', brief: 'CV workshop Thursday' } })).status()).toBe(403);
    expect((await admin.post('/api/admin/ai/draft', { data: { purpose: 'announcement', brief: 'CV workshop Thursday' } })).status()).toBe(501);
    expect((await mentor.post('/api/admin/ai/company-enrich', { data: { text: pasted } })).status()).toBe(403);
    expect((await admin.post('/api/admin/ai/company-enrich', { data: { text: pasted } })).status()).toBe(501);
    // A mentor's own profile: mentors only, their own consent first.
    expect((await mentee.post('/api/profile/enrich', { data: { text: pasted } })).status()).toBe(403);
    const noConsent = await mentor.post('/api/profile/enrich', { data: { text: pasted } });
    expect(noConsent.status()).toBe(403);
    expect((await noConsent.json()).code).toBe('consent_required');
    const mentorId = (await prisma.user.findFirstOrThrow({ where: { email: mentorEmail }, select: { id: true } })).id;
    await prisma.userConsent.upsert({
      where: { userId_type: { userId: mentorId, type: 'AI_CV_PARSING' } },
      create: { userId: mentorId, type: 'AI_CV_PARSING', grantedAt: new Date() },
      update: { revokedAt: null },
    });
    expect((await mentor.post('/api/profile/enrich', { data: { text: pasted } })).status()).toBe(501);
  } finally {
    await Promise.all([admin.dispose(), mentor.dispose(), mentee.dispose()]);
  }
});

test('a brief drafts all three languages into an empty editor, every one marked for review', async ({ page }) => {
  const stamp = Date.now();
  await page.route('**/api/admin/ai/draft', (route) =>
    route.fulfill({ json: { draft: { en: `Book your CV check ${stamp}`, tr: `CV kontrolünü planla ${stamp}`, de: `Buche deinen Lebenslauf-Check ${stamp}` } } }),
  );
  await signInAndSettle(page, adminEmail, PW, '/admin');
  await gotoSettled(page, '/admin/goal-templates');
  const v = (id: string) => page.locator(`[data-testid="${id}"]:visible`);
  await expect(async () => {
    await v('new-template-draft-brief').fill('Remind mentees to book a CV check');
    await v('new-template-draft').click();
    await expect(v('new-template-en')).toHaveValue(`Book your CV check ${stamp}`, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(v('new-template-tr')).toHaveValue(`CV kontrolünü planla ${stamp}`);
  for (const l of ['en', 'tr', 'de']) await expect(v(`new-template-${l}-machine`)).toBeVisible();
  // The editor is no longer empty: no second draft can replace it.
  await expect(v('new-template-draft')).toHaveCount(0);
});

test('a mentor accepts proposed profile fields one by one, and nothing is saved until they save', { tag: '@smoke' }, async ({ page }) => {
  const stamp = Date.now();
  const proposal = { bio: `I help juniors ship backend services ${stamp}.`, skills: ['Kotlin', 'PostgreSQL'], interests: `Fintech, career switching ${stamp}` };
  await page.route('**/api/profile/enrich', (route) => route.fulfill({ json: { proposal } }));
  await signInAndSettle(page, mentorEmail, PW, '/mentor');
  await gotoSettled(page, '/mentor/profile');
  const v = (id: string) => page.locator(`[data-testid="${id}"]:visible`);
  await expect(async () => {
    await v('mentor-enrich-open').click();
    await expect(v('mentor-enrich-text')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await v('mentor-enrich-text').fill('Ten years of backend work in fintech, Kotlin and Postgres; I run the internal mentoring circle.');
  await v('mentor-enrich-suggest').click();
  await v('mentor-enrich-field-bio-accept').click();
  await v('mentor-enrich-field-interests-reject').click();
  await v('mentor-enrich-field-skills-accept').click();

  await expect(page.locator('textarea[name="bio"]:visible')).toHaveValue(proposal.bio);
  await expect(page.locator('input[name="interests"]:visible')).not.toHaveValue(proposal.interests);
  await expect(page.getByText('Kotlin', { exact: true }).first()).toBeVisible();
  // Accepting fills the form; it does not save it.
  const stored = await prisma.user.findFirstOrThrow({ where: { email: mentorEmail }, select: { bio: true } });
  expect(stored.bio ?? '').not.toContain(String(stamp));
});
