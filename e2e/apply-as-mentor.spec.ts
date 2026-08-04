import { test, expect } from '@playwright/test';
import { prisma, uniqueEmail } from './helpers/db';

// #905: public, unauthenticated "become a mentor" form against the #904 API
// (POST /api/mentor-applications). The happy path below is the only real
// network call this file makes — it shares the endpoint's per-IP rate-limit
// bucket (5 / 15 min, see e2e/mentor-applications.spec.ts) with the rest of
// the suite, so keep it to one submission. The 409/429 cases are pure
// client-side rendering given a fixed API response, so they're verified via
// route interception instead of spending more of that shared quota.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('apply-as-mentor form requires consent, submits, and confirms no account was created', { tag: '@smoke' }, async ({ page }) => {
  const email = uniqueEmail('apply-mentor');

  await page.goto('/apply-as-mentor');

  await page.getByLabel(/full name/i).fill('New Mentor E2E');
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel(/expertise/i).fill('React, Node.js');

  // Consent is mandatory: submitting without it must not reach the API.
  await page.getByRole('button', { name: /submit application/i }).click();
  await expect(page.getByText(/accept the privacy and terms/i)).toBeVisible();
  expect(await prisma.mentorApplication.count({ where: { email } })).toBe(0);

  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /submit application/i }).click();

  try {
    await expect(page.getByTestId('apply-mentor-success')).toBeVisible({ timeout: 10_000 });
    // The success screen must be explicit that this didn't create an account.
    await expect(page.getByText(/does not create an account/i)).toBeVisible();

    const application = await prisma.mentorApplication.findFirst({ where: { email } });
    expect(application).toBeTruthy();
    expect(application?.status).toBe('PENDING');
    expect(application?.consentAt).not.toBeNull();
  } finally {
    await prisma.mentorApplication.deleteMany({ where: { email } });
  }
});

test('a duplicate pending application (409) gets a distinct message from a rate limit (429)', { tag: '@smoke' }, async ({ page }) => {
  const fillMinimalForm = async () => {
    await page.getByLabel(/full name/i).fill('Mocked Mentor');
    await page.getByLabel(/^email/i).fill(uniqueEmail('apply-mentor-mock'));
    await page.getByLabel(/expertise/i).fill('Design');
    await page.getByRole('checkbox').check();
  };

  await page.route('**/api/mentor-applications', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'You already have a pending application' }),
    })
  );
  await page.goto('/apply-as-mentor');
  await fillMinimalForm();
  await page.getByRole('button', { name: /submit application/i }).click();
  await expect(page.getByText(/already have a pending application/i)).toBeVisible();

  await page.route('**/api/mentor-applications', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'Retry-After': '900' },
      body: JSON.stringify({ error: 'Too many requests. Please try again later.' }),
    })
  );
  await page.reload();
  await fillMinimalForm();
  await page.getByRole('button', { name: /submit application/i }).click();
  await expect(page.getByText(/too many attempts/i)).toBeVisible();
});
