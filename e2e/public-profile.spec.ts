import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a public profile shows safe fields but not PII; a private one 404s', async ({ page }) => {
  const pubEmail = uniqueEmail('pubprofile');
  const privEmail = uniqueEmail('privprofile');
  const pub = await seedUser(pubEmail, 'Pass123!', 'MENTEE', 'Public Person');
  const priv = await seedUser(privEmail, 'Pass123!', 'MENTEE', 'Private Person');
  await prisma.user.update({
    where: { id: pub.id },
    data: { publicProfile: true, university: 'TH Köln', phone: '+49 111 222', skills: ['React', 'Python'] },
  });

  try {
    // Public profile is visible without auth and shows safe fields only.
    await page.goto(`/p/${pub.id}`);
    await expect(page.getByRole('heading', { name: 'Public Person' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('TH Köln')).toBeVisible();
    await expect(page.getByText('React')).toBeVisible();
    // PII must NOT be exposed.
    await expect(page.getByText(pubEmail)).toHaveCount(0);
    await expect(page.getByText('+49 111 222')).toHaveCount(0);

    // A non-public profile is not found.
    const resp = await page.goto(`/p/${priv.id}`);
    expect(resp?.status()).toBe(404);
  } finally {
    await cleanupByEmail(pubEmail);
    await cleanupByEmail(privEmail);
  }
});

test('public contact form notifies the owner; honeypot drops bots', async ({ page }) => {
  const email = uniqueEmail('pubcontact');
  const user = await seedUser(email, 'Pass123!', 'MENTEE', 'Contact Target');
  await prisma.user.update({ where: { id: user.id }, data: { publicProfile: true } });

  try {
    await page.goto(`/p/${user.id}`);
    // Product link + contact form are present on the public page.
    await expect(page.getByRole('link', { name: /InternshipCRM/i }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder(/Your name|Adınız|Ihr Name/)).toBeVisible();

    // Genuine submission → notification for the owner.
    const ok = await page.request.post(`/api/public-contact/${user.id}`, {
      data: { name: 'Recruiter', email: 'r@co.com', message: 'We have a role for you.', renderedAt: Date.now() - 5000 },
    });
    expect(ok.ok()).toBeTruthy();

    // Honeypot filled → silently accepted (200) but dropped.
    const bot = await page.request.post(`/api/public-contact/${user.id}`, {
      data: { name: 'Bot', email: 'b@spam.com', message: 'spam', website: 'http://x', renderedAt: Date.now() - 5000 },
    });
    expect(bot.ok()).toBeTruthy();

    await expect(async () => {
      const notes = await prisma.notification.findMany({ where: { userId: user.id, type: 'public_contact' } });
      expect(notes.length).toBe(1);
      expect(notes[0].text).toContain('Recruiter');
    }).toPass({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
  }
});
