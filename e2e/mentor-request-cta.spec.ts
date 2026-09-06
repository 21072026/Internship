import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1773 — "Request this mentor" CTA. The directory card and a mentor's public
// profile give a signed-in MENTEE a one-click route into the portal's request
// panel at /portal?mentor=<id>, which preselects that mentor in the existing
// preferred-mentor picker (#939). The CTA is a convenience only: POST
// /api/mentorship-requests still re-validates the id against active MENTOR +
// publicProfile + a live MENTOR_DIRECTORY_VISIBILITY consent, so an id that is
// not in the consent-gated list must land on an empty picker and a visible
// fallback line rather than on a submit the server would reject.

async function signIn(page: Page, email: string, password: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

// The onboarding gate (#591): a request is only accepted once profile + CV are
// complete, so the walkthrough has to satisfy it before it can submit.
async function completeOnboarding(menteeId: string) {
  await prisma.user.update({
    where: { id: menteeId },
    data: { university: 'Test University', skills: ['React'] },
  });
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: menteeId, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });
}

// Directory visibility = publicProfile opt-in AND an active
// MENTOR_DIRECTORY_VISIBILITY consent (#937) — the exact rule GET /api/mentors
// and the preferredMentorId check both apply.
async function makeDirectoryVisible(mentorId: string) {
  await prisma.user.update({ where: { id: mentorId }, data: { publicProfile: true, acceptingMentees: true } });
  await prisma.userConsent.create({
    data: { userId: mentorId, type: 'MENTOR_DIRECTORY_VISIBILITY', grantedAt: new Date() },
  });
}

test.describe('request this mentor', () => {
  const menteeEmail = uniqueEmail('cta-mentee');
  const mentorEmail = uniqueEmail('cta-mentor');
  const hiddenEmail = uniqueEmail('cta-hidden');
  const otherMentorEmail = uniqueEmail('cta-viewer');
  const pw = 'CtaPass1234';

  let menteeId = '';
  let mentorId = '';
  let hiddenId = '';

  test.beforeAll(async () => {
    const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'CTA Mentee');
    menteeId = mentee.id;
    await completeOnboarding(mentee.id);

    const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'CTA Wanted Mentor');
    mentorId = mentor.id;
    await makeDirectoryVisible(mentor.id);

    // Deliberately NOT directory-visible — the same shape as a mentor who
    // revoked their consent after the link was copied. publicProfile is on so
    // /p/<id> still resolves; the directory consent is what is missing.
    const hidden = await seedUser(hiddenEmail, pw, 'MENTOR', 'CTA Hidden Mentor');
    hiddenId = hidden.id;
    await prisma.user.update({ where: { id: hidden.id }, data: { publicProfile: true } });

    await seedUser(otherMentorEmail, pw, 'MENTOR', 'CTA Viewer Mentor');
  });

  test.afterAll(async () => {
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId } });
    for (const email of [menteeEmail, mentorEmail, hiddenEmail, otherMentorEmail]) {
      await cleanupByEmail(email);
    }
  });

  test('directory card -> prefilled panel -> submitted request', { tag: '@smoke' }, async ({ page }) => {
    await signIn(page, menteeEmail, pw, '/portal');

    await page.goto('/mentors');
    await expect(page.getByTestId(`mentor-card-${mentorId}`)).toBeVisible({ timeout: 15_000 });

    // 1. The CTA on the directory card links into the portal request panel.
    await page.getByTestId(`mentor-request-${mentorId}`).click();
    await page.waitForURL((u) => u.pathname === '/portal' && u.searchParams.get('mentor') === mentorId, {
      timeout: 20_000,
    });

    // 2. The panel preselects that mentor and says so above the form. The
    //    picker's options load async, so both assertions get a long timeout.
    const panel = page.getByTestId('mentorship-request');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId('request-preferred-mentor')).toHaveValue(mentorId, { timeout: 15_000 });
    await expect(panel.getByTestId('request-preferred-mentor-confirmation')).toContainText('CTA Wanted Mentor');
    await expect(panel.getByTestId('request-preferred-mentor-unavailable')).toHaveCount(0);

    // 3. Submitting from there files the request against that mentor.
    await panel.getByTestId('request-submit').click();
    await expect(panel.getByTestId('request-pending')).toBeVisible({ timeout: 15_000 });

    const stored = await prisma.mentorshipRequest.findFirst({ where: { menteeId } });
    expect(stored?.status).toBe('PENDING');
    expect(stored?.preferredMentorId).toBe(mentorId);

    // Leave no PENDING row behind: the panel's form is hidden while one exists,
    // and the other tests in this file share the mentee.
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId } });
  });

  test('a mentor who is not directory-visible falls back to an empty picker and a notice', async ({ page }) => {
    await signIn(page, menteeEmail, pw, '/portal');

    await page.goto(`/portal?mentor=${hiddenId}`);
    const panel = page.getByTestId('mentorship-request');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId('request-preferred-mentor-unavailable')).toBeVisible({ timeout: 15_000 });
    // Empty, still editable, and no false confirmation line.
    await expect(panel.getByTestId('request-preferred-mentor')).toHaveValue('');
    await expect(panel.getByTestId('request-preferred-mentor')).toBeEnabled();
    await expect(panel.getByTestId('request-preferred-mentor-confirmation')).toHaveCount(0);
  });

  test('the public profile CTA takes a mentee to the prefilled panel', async ({ page }) => {
    await signIn(page, menteeEmail, pw, '/portal');

    await page.goto(`/p/${mentorId}`);
    await page.getByTestId('public-profile-request-mentor').click();
    await page.waitForURL((u) => u.pathname === '/portal' && u.searchParams.get('mentor') === mentorId, {
      timeout: 20_000,
    });
    await expect(page.getByTestId('request-preferred-mentor')).toHaveValue(mentorId, { timeout: 15_000 });
  });

  test('a signed-out visitor sees no CTA on the public profile', async ({ page }) => {
    await page.goto(`/p/${mentorId}`);
    await expect(page.getByTestId('public-profile-request-mentor')).toHaveCount(0);
  });

  test('a MENTOR viewer gets neither the card CTA nor the profile CTA', async ({ page }) => {
    await signIn(page, otherMentorEmail, pw, '/mentor');

    await page.goto(`/p/${mentorId}`);
    await expect(page.getByTestId('public-profile-request-mentor')).toHaveCount(0);

    await page.goto('/mentors');
    await expect(page.getByTestId(`mentor-card-${mentorId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`mentor-request-${mentorId}`)).toHaveCount(0);
  });
});
