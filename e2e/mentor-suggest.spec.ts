import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { seedSkillTaxonomy } from '../src/lib/skillsResolve';

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

// #1821: suggestions score canonical skills with adjacency. A mentee holding
// React is suggested a mentor holding only Frontend — below an exact match, with
// the adjacency named — and removing the SkillEdge removes that credit: the
// relationship is data, not a hardcoded pair.
test('mentor suggestion counts an adjacent skill below an exact one, from SkillEdge data', async ({ request }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'SuggestPass123';
  const org = await prisma.organization.create({ data: { name: `Suggest Adj ${stamp}`, slug: `sugg-adj-${stamp}` } });
  try {
    await seedSkillTaxonomy(org.id);
    const skill = (key: string) => prisma.skill.findFirstOrThrow({ where: { orgId: org.id, key } });
    const [react, frontend] = await Promise.all([skill('react'), skill('frontend')]);
    const adminEmail = uniqueEmail('sugg-adj-admin');
    await seedUser(adminEmail, pw, 'ADMIN', 'Adj Admin', org.id);
    const mk = async (name: string, role: 'MENTOR' | 'MENTEE', skillId: string | null) => {
      const u = await seedUser(uniqueEmail(`sugg-adj-${role.toLowerCase()}`), 'x', role, name, org.id);
      if (skillId) await prisma.userSkill.create({ data: { userId: u.id, skillId } });
      return u;
    };
    const mentee = await mk('Adj Mentee', 'MENTEE', react.id);
    const exact = await mk('Exact Mentor', 'MENTOR', react.id);
    const near = await mk('Frontend Mentor', 'MENTOR', frontend.id);
    await mk('Unrelated Mentor', 'MENTOR', null);

    expect((await signInViaApi(request, adminEmail, pw)).ok).toBe(true);
    const suggest = async () => {
      const res = await request.post('/api/admin/mentor-suggest', { data: { menteeId: mentee.id } });
      expect(res.ok()).toBe(true);
      return (await res.json()) as {
        aiUsed: boolean;
        suggestions: { mentorId: string; score: number; sharedSkills: string[]; adjacentSkills: { skill: string; via: string; weight: number }[] }[];
      };
    };

    const body = await suggest();
    expect(body.aiUsed).toBe(false);
    const ids = body.suggestions.map((s) => s.mentorId);
    expect(ids.indexOf(exact.id)).toBe(0);
    expect(ids.indexOf(near.id)).toBe(1);
    const nearRow = body.suggestions[1];
    expect(nearRow.score).toBeGreaterThan(0);
    expect(nearRow.score).toBeLessThan(1);
    expect(nearRow.adjacentSkills).toEqual([{ skill: frontend.labelEn, via: react.labelEn, weight: nearRow.score }]);
    expect(body.suggestions[0].sharedSkills).toEqual([react.labelEn]);

    // Remove the edge: the neighbour no longer counts.
    await prisma.skillEdge.deleteMany({
      where: { orgId: org.id, OR: [{ fromSkillId: react.id, toSkillId: frontend.id }, { fromSkillId: frontend.id, toSkillId: react.id }] },
    });
    const after = await suggest();
    const nearAfter = after.suggestions.find((s) => s.mentorId === near.id);
    expect(nearAfter?.adjacentSkills ?? []).toEqual([]);
    expect(nearAfter?.score ?? 0).toBe(0);
  } finally {
    await prisma.matchFeedback.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
