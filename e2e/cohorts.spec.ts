import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin creates a cohort, assigns a mentee, and filters by it', async ({ page }) => {
  const adminEmail = uniqueEmail('co-admin');
  const mentorEmail = uniqueEmail('co-mentor');
  const menteeEmail = uniqueEmail('co-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Co Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Co Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Co Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  let cohortId = '';

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const created = await page.request.post('/api/cohorts', { data: { name: 'Spring 2026', term: '2026 Spring' } });
    expect(created.status()).toBe(201);
    cohortId = (await created.json()).cohort.id;

    const put = await page.request.put(`/api/mentorship/${rel.id}`, { data: { cohortId } });
    expect(put.ok()).toBeTruthy();

    const list = await (await page.request.get('/api/cohorts')).json();
    expect(list.cohorts.find((c: { id: string }) => c.id === cohortId)?.interns).toBeGreaterThan(0);

    const cands = await (await page.request.get(`/api/candidates?cohort=${cohortId}`)).json();
    expect(cands.candidates.some((c: { id: string }) => c.id === mentee.id)).toBeTruthy();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    if (cohortId) await prisma.cohort.deleteMany({ where: { id: cohortId } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
