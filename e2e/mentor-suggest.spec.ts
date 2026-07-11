import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Faz 2 (#533): mentor suggestion — rule-based ranking always works; AI
// deepening is behind the AI gate. CI has no provider key, so the endpoint
// must gracefully fall back (aiUsed:false) while still ranking by skill
// overlap and respecting capacity.
test('mentor suggestion ranks by skill overlap and falls back gracefully without AI', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const adminEmail = uniqueEmail('sugg-admin');
  const goodEmail = uniqueEmail('sugg-good');
  const weakEmail = uniqueEmail('sugg-weak');
  const fullEmail = uniqueEmail('sugg-full');
  const menteeEmail = uniqueEmail('sugg-mentee');
  const busyMenteeEmail = uniqueEmail('sugg-busy-mentee');
  const pw = 'SuggestPass123';
  const skill = `RustLang${stamp}`; // unique skill so parallel data can't interfere

  await seedUser(adminEmail, pw, 'ADMIN', 'Suggest Admin');
  const good = await seedUser(goodEmail, 'x', 'MENTOR', 'Good Match Mentor');
  const weak = await seedUser(weakEmail, 'x', 'MENTOR', 'Weak Match Mentor');
  const full = await seedUser(fullEmail, 'x', 'MENTOR', 'Full Capacity Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Suggest Mentee');
  const busyMentee = await seedUser(busyMenteeEmail, 'x', 'MENTEE', 'Busy Mentee');

  await prisma.user.update({ where: { id: good.id }, data: { skills: [skill, 'Systems'] } });
  await prisma.user.update({ where: { id: weak.id }, data: { skills: ['Marketing'] } });
  // Perfect overlap but at capacity → must be excluded.
  await prisma.user.update({ where: { id: full.id }, data: { skills: [skill], mentorCapacity: 1 } });
  const fullRel = await prisma.mentorshipRelation.create({ data: { mentorId: full.id, menteeId: busyMentee.id, status: 'ACTIVE' } });
  await prisma.user.update({ where: { id: mentee.id }, data: { skills: [skill], targetPosition: 'Systems Engineer' } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/admin/mentor-suggest', { data: { menteeId: mentee.id } });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // No provider key in CI → graceful rule-based fallback.
    expect(body.aiUsed).toBe(false);
    const suggestions = body.suggestions as { mentorId: string; sharedSkills: string[] }[];
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    // Best match first (shares the unique skill), the at-capacity mentor excluded.
    expect(suggestions[0].mentorId).toBe(good.id);
    expect(suggestions[0].sharedSkills).toContain(skill);
    expect(suggestions.map((s) => s.mentorId)).not.toContain(full.id);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: fullRel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(busyMenteeEmail);
    await cleanupByEmail(goodEmail);
    await cleanupByEmail(weakEmail);
    await cleanupByEmail(fullEmail);
    await cleanupByEmail(adminEmail);
  }
});
