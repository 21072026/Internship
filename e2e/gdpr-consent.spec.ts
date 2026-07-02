import { test, expect } from '@playwright/test';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';
import { PRIVACY_POLICY_VERSION } from '../src/lib/privacy';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Slice B (#402): the privacy notice covers GDPR Art. 13 items and shows the
// policy version; registration records which version was accepted (Art. 7).
test('privacy notice shows the version and the recipients/rights disclosure', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.getByText(PRIVACY_POLICY_VERSION)).toBeVisible();
  await expect(page.getByRole('heading', { name: /who can see your data/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /your rights/i })).toBeVisible();
});

test('registration records the accepted privacy-policy version', async ({ page }) => {
  const email = uniqueEmail('gdpr-consent');
  try {
    const res = await page.request.post('/api/register', {
      data: {
        email,
        password: 'ConsentPass123',
        fullName: 'Consent Version User',
        consent: true,
        privacyVersion: PRIVACY_POLICY_VERSION,
      },
    });
    expect(res.ok()).toBeTruthy();

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    const consent = await prisma.userConsent.findUnique({
      where: { userId_type: { userId: user!.id, type: 'PRIVACY_POLICY' } },
    });
    expect(consent?.grantedAt).not.toBeNull();
    expect(consent?.version).toBe(PRIVACY_POLICY_VERSION);
  } finally {
    await cleanupByEmail(email);
  }
});
