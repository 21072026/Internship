import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin creates a referral source, assigns a mentee, filters by it, and sees conversion', async ({ page }) => {
  const adminEmail = uniqueEmail('src-admin');
  const mentorEmail = uniqueEmail('src-mentor');
  const menteeEmail = uniqueEmail('src-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Src Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Src Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Src Mentee');
  // The mentee is hired, so the source should report 100% conversion.
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'HIRED_660' },
  });
  const sourceName = `University Fair ${Date.now()}`;
  let sourceId = '';

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Create the source through the admin UI.
    await page.goto('/admin/sources');
    await page.locator('#name').fill(sourceName);
    await page.locator('#contact-name').fill('Career Office');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText(sourceName)).toBeVisible({ timeout: 10_000 });

    const list = await (await page.request.get('/api/admin/sources')).json();
    const src = list.sources.find((s: { name: string }) => s.name === sourceName);
    expect(src).toBeTruthy();
    sourceId = src.id;

    // Assign the mentee to this source.
    const patch = await page.request.patch(`/api/users/${mentee.id}`, { data: { sourceId } });
    expect(patch.ok()).toBeTruthy();

    // Candidate list filters by source.
    const cands = await (await page.request.get(`/api/candidates?source=${sourceId}`)).json();
    expect(cands.candidates.some((c: { id: string }) => c.id === mentee.id)).toBeTruthy();

    // Conversion stats reflect the hired mentee.
    const after = await (await page.request.get('/api/admin/sources')).json();
    const stat = after.sources.find((s: { id: string }) => s.id === sourceId);
    expect(stat.mentees).toBe(1);
    expect(stat.hired).toBe(1);
    expect(stat.conversion).toBe(100);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await prisma.user.updateMany({ where: { id: mentee.id }, data: { sourceId: null } });
    if (sourceId) await prisma.source.deleteMany({ where: { id: sourceId } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
