import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #591: the mentorship request is gated on onboarding completion (profile
// basics + CV). The server enforces it (400 with the missing steps) and the
// portal panel shows the missing list with a disabled submit.
test('mentorship request is blocked until profile and CV are complete', async ({ page }) => {
  const email = uniqueEmail('gate-mentee');
  const pw = 'GatePass123';
  const mentee = await seedUser(email, pw, 'MENTEE', 'Gate Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Server-side: incomplete onboarding → 400 with the missing steps.
    let res = await page.request.post('/api/mentorship-requests', { data: {} });
    expect(res.status()).toBe(400);
    let body = await res.json();
    expect(body.code).toBe('onboarding_incomplete');
    expect(body.missing).toContain('profile');
    expect(body.missing).toContain('cv');

    // UI: the panel lists what's missing and the submit button is disabled.
    await page.goto('/portal');
    await expect(page.getByTestId('request-gate')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('request-submit')).toBeDisabled();

    // Complete profile only → cv still missing.
    await prisma.user.update({ where: { id: mentee.id }, data: { university: 'Gate University', skills: ['SQL'] } });
    res = await page.request.post('/api/mentorship-requests', { data: {} });
    body = await res.json();
    expect(res.status()).toBe(400);
    expect(body.missing).toEqual(['cv']);

    // Upload the CV → the request goes through.
    const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
    await prisma.cvFile.create({
      data: { userId: mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
    });
    res = await page.request.post('/api/mentorship-requests', { data: {} });
    expect(res.status()).toBe(201);
  } finally {
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(email);
  }
});
