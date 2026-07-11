import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Faz 2 (#537): every AI call goes through the central gate — consent → quota
// → provider. CI has no ANTHROPIC_API_KEY, so the provider step always denies
// with 501, which lets us assert each earlier gate precisely, including both
// quota scenarios (quota=0 and quota consumed by prior usage). Restores the
// quota setting and cleans its AiUsage rows in finally.
test('AI gate enforces consent then quota then provider configuration, without consuming credit on failure', async ({ page }) => {
  const menteeEmail = uniqueEmail('aigate-mentee');
  const adminEmail = uniqueEmail('aigate-admin');
  const pw = 'AiGatePass123';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'AiGate Mentee');
  await seedUser(adminEmail, pw, 'ADMIN', 'AiGate Admin');

  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });

  const usageBefore = await prisma.aiUsage.count();

  try {
    // Admin session to flip the quota setting.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
    const adminReq = page.request;

    // Mentee session in a second context.
    const menteeCtx = await page.context().browser()!.newContext();
    const menteePage = await menteeCtx.newPage();
    await menteePage.goto('/auth/signin');
    await menteePage.fill('input[type="email"], input[name="email"]', menteeEmail);
    await menteePage.fill('input[type="password"]', pw);
    await menteePage.click('button[type="submit"]');
    await menteePage.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // 1. No consent → denied at the consent gate.
    let res = await menteePage.request.post(`/api/cv/${mentee.id}/extract-ai`);
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('consent_required');

    await menteePage.request.post('/api/consent', { data: { type: 'AI_CV_PARSING', granted: true } });

    // 2. Quota = 0 → AI is off org-wide; denied safely even with consent.
    await adminReq.put('/api/admin/settings', { data: { aiMonthlyQuota: '0' } });
    res = await menteePage.request.post(`/api/cv/${mentee.id}/extract-ai`);
    expect(res.status()).toBe(429);
    expect((await res.json()).code).toBe('quota_exceeded');

    // 3. Quota = 1 but already consumed this month → still denied.
    await adminReq.put('/api/admin/settings', { data: { aiMonthlyQuota: '1' } });
    const marker = await prisma.aiUsage.create({ data: { scope: 'e2e_marker' } });
    res = await menteePage.request.post(`/api/cv/${mentee.id}/extract-ai`);
    expect(res.status()).toBe(429);
    await prisma.aiUsage.delete({ where: { id: marker.id } });

    // 4. Quota available → passes to the provider step (no key in CI → 501).
    await adminReq.put('/api/admin/settings', { data: { aiMonthlyQuota: '200' } });
    res = await menteePage.request.post(`/api/cv/${mentee.id}/extract-ai`);
    expect(res.status()).toBe(501);
    expect((await res.json()).code).toBe('not_configured');

    // No failed attempt consumed any credit.
    expect(await prisma.aiUsage.count()).toBe(usageBefore);

    await menteeCtx.close();
  } finally {
    await page.request.put('/api/admin/settings', { data: { aiMonthlyQuota: '200' } }).catch(() => {});
    await prisma.aiUsage.deleteMany({ where: { scope: 'e2e_marker' } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
