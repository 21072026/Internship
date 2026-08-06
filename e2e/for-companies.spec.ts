import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1102/#1104: the company door. Companies have no self-service sign-up, so the
// public page ends in an enquiry that has to be captured — not a register link.
test('the company page is public and the landing CTA points at it', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/');
  const cta = page.getByRole('link', { name: /Talk to us as a company/i }).first();
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute('href', '/for-companies');

  await page.goto('/for-companies');
  await expect(page.getByRole('heading', { name: /Meet the candidate through the mentor/i })).toBeVisible();
  // Signed out, and no register button anywhere on the company path.
  await expect(page.getByRole('link', { name: /Create a free account/i })).toHaveCount(0);
});

test('an enquiry is captured and shows up for admins', async ({ page }) => {
  const email = `company-${Date.now()}@e2e.local`;
  try {
    await page.goto('/for-companies');
    await page.getByRole('button', { name: /Necessary only/i }).click().catch(() => {});

    await page.fill('#company', 'E2E Talent GmbH');
    await page.fill('#your-name', 'Ada Lovelace');
    await page.fill('#work-email', email);
    await page.fill('#inquiry-message', 'We are hiring two junior developers.');
    await page.getByRole('checkbox').check();

    // The server drops submits faster than 3s as bot traffic — that is the
    // point of the anti-spam rule, so wait it out rather than defeat it.
    await page.waitForTimeout(3200);
    await page.getByRole('button', { name: /Request a look/i }).click();

    await expect(page.getByTestId('company-inquiry-success')).toBeVisible({ timeout: 15_000 });

    const row = await prisma.companyInquiry.findFirst({ where: { email } });
    expect(row?.companyName).toBe('E2E Talent GmbH');
    expect(row?.status).toBe('NEW');
    // Consent is recorded server-side, not just checked in the UI (GDPR Art. 7).
    expect(row?.consentAt).not.toBeNull();
  } finally {
    await prisma.companyInquiry.deleteMany({ where: { email } });
  }
});

test('a honeypot submission is accepted but dropped', async ({ page, request }) => {
  const email = `bot-${Date.now()}@e2e.local`;
  try {
    await page.goto('/for-companies');
    const res = await request.post('/api/company-inquiry', {
      data: {
        companyName: 'Spam Co',
        contactName: 'Bot',
        email,
        consent: true,
        website: 'http://spam.example',
        renderedAt: Date.now() - 10_000,
      },
    });
    // 200 so the bot gets no signal…
    expect(res.ok()).toBeTruthy();
    // …but nothing was stored.
    expect(await prisma.companyInquiry.count({ where: { email } })).toBe(0);
  } finally {
    await prisma.companyInquiry.deleteMany({ where: { email } });
  }
});
