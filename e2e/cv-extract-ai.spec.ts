import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC B3 — AI extraction is double-gated: it needs active AI_CV_PARSING consent
// AND a configured ANTHROPIC_API_KEY. CI has no key, so we assert the gates
// (no real AI call happens): no consent → 403; consent but no key → 501.
test('AI CV extraction is gated by consent and configuration', async ({ page }) => {
  const email = uniqueEmail('cvai-mentee');
  const user = await seedUser(email, 'MenteePass123', 'MENTEE', 'CV AI Mentee');

  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: user.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });
  await prisma.user.update({ where: { id: user.id }, data: { cvUrl: `/api/cv/${user.id}` } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // No consent yet → 403 consent_required.
    let res = await page.request.post(`/api/cv/${user.id}/extract-ai`);
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('consent_required');

    // Grant consent → now gated only by configuration. CI has no key → 501.
    await page.request.post('/api/consent', { data: { type: 'AI_CV_PARSING', granted: true } });
    res = await page.request.post(`/api/cv/${user.id}/extract-ai`);
    expect(res.status()).toBe(501);
    expect((await res.json()).code).toBe('not_configured');
  } finally {
    await cleanupByEmail(email);
  }
});
