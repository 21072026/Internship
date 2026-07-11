import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Faz 2 (#535): AI CV feedback for the mentee — free for them, gated by their
// own AI_CV_PARSING consent and the shared AI gate. CI has no provider key, so
// the availability endpoint reports configured:false (UI hides the feature)
// and consent-granted POSTs stop at 501.
test('CV feedback availability and gates behave without a provider key', async ({ page }) => {
  const email = uniqueEmail('cvfb-mentee');
  const pw = 'CvFbPass123';
  const user = await seedUser(email, pw, 'MENTEE', 'CV Feedback Mentee');
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: user.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Availability: CV present, no key in CI → configured:false (UI hidden).
    const avail = await (await page.request.get('/api/cv/feedback')).json();
    expect(avail.hasCv).toBe(true);
    expect(avail.configured).toBe(false);
    expect(avail.consent).toBe(false);

    // No consent → consent gate first.
    let res = await page.request.post('/api/cv/feedback');
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('consent_required');

    // With consent → passes to the provider step (no key → 501), and the
    // failure consumes no AI credit.
    await page.request.post('/api/consent', { data: { type: 'AI_CV_PARSING', granted: true } });
    const usageBefore = await prisma.aiUsage.count();
    res = await page.request.post('/api/cv/feedback');
    expect(res.status()).toBe(501);
    expect((await res.json()).code).toBe('not_configured');
    expect(await prisma.aiUsage.count()).toBe(usageBefore);
  } finally {
    await cleanupByEmail(email);
  }
});
