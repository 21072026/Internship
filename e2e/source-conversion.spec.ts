import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Premium Faz 2 (#539): source-conversion report, behind the same
// premiumAnalytics setting as cohort comparison. Restores the flag in finally.
test('source conversion is locked by default and reports per-source hire rates once enabled', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const adminEmail = uniqueEmail('src-admin');
  const mentorEmail = uniqueEmail('src-mentor');
  const hiredEmail = uniqueEmail('src-hired');
  const activeEmail = uniqueEmail('src-active');
  const pw = 'SourcePass123';

  await seedUser(adminEmail, pw, 'ADMIN', 'Source Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Source Mentor');
  const hiredMentee = await seedUser(hiredEmail, 'x', 'MENTEE', 'Source Hired Mentee');
  const activeMentee = await seedUser(activeEmail, 'x', 'MENTEE', 'Source Active Mentee');

  const source = await prisma.source.create({ data: { name: `Conv Source ${stamp}` } });
  await prisma.user.update({ where: { id: hiredMentee.id }, data: { sourceId: source.id } });
  await prisma.user.update({ where: { id: activeMentee.id }, data: { sourceId: source.id } });

  const hiredRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: hiredMentee.id, pipelineStatus: 'HIRED_660' },
  });
  const activeRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: activeMentee.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Locked by default.
    expect((await page.request.get('/api/admin/analytics/sources')).status()).toBe(403);

    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } });

    const res = await page.request.get('/api/admin/analytics/sources');
    expect(res.ok()).toBeTruthy();
    const rows = (await res.json()).sources as { id: string; mentees: number; inPipeline: number; hired: number; conversionToHired: number }[];
    const mine = rows.find((r) => r.id === source.id);
    expect(mine).toBeTruthy();
    expect(mine!.mentees).toBe(2);
    expect(mine!.inPipeline).toBe(2);
    expect(mine!.hired).toBe(1);
    expect(mine!.conversionToHired).toBe(50);
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [hiredRel.id, activeRel.id] } } });
    await cleanupByEmail(hiredEmail);
    await cleanupByEmail(activeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
    await prisma.source.delete({ where: { id: source.id } }).catch(() => {});
  }
});
