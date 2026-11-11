import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { seedSkillTaxonomy } from '../src/lib/skillsResolve';
import { gotoSettled, signInAndSettle } from './helpers/auth';

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
    // The engine's 0-100 score since #1787: an exact skill is the whole
    // skills rule, a neighbour its edge weight of it.
    expect(nearRow.score).toBeGreaterThan(0);
    expect(nearRow.score).toBeLessThan(100);
    expect(nearRow.adjacentSkills).toEqual([{ skill: frontend.labelEn, via: react.labelEn, weight: nearRow.score / 100 }]);
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

// #1787: every suggestion is scored by the org's rule set and explained. A
// request's preferred field feeds the score (and changes the order), a mentor
// who switched intake off comes back as blocked — never silently dropped — and
// the approval queue shows the same compact breakdown while keeping the
// mentee's preferred mentor as the picked default.
test('suggestions are scored by the org rule set, honour a request and show in the queue', async ({ page, playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'SuggestPass123';
  const org = await prisma.organization.create({ data: { name: `Suggest Rules ${stamp}`, slug: `sugg-rules-${stamp}` } });
  const ruleSet = await prisma.matchRuleSet.create({
    data: {
      orgId: org.id, name: 'Skills + field', isDefault: true, version: 4,
      rules: {
        create: [
          { orgId: org.id, dimension: 'skills', kind: 'WEIGHTED', weight: 50, sortOrder: 0 },
          { orgId: org.id, dimension: 'field', kind: 'WEIGHTED', weight: 50, sortOrder: 1 },
          { orgId: org.id, dimension: 'capacityHeadroom', kind: 'HARD_REQUIRE', weight: 0, sortOrder: 2 },
        ],
      },
    },
  });
  const adminEmail = uniqueEmail('sugg-rules-admin');
  const api = await playwright.request.newContext({ baseURL });
  try {
    await seedUser(adminEmail, pw, 'ADMIN', 'Rules Admin', org.id);
    const mk = async (name: string, role: 'MENTOR' | 'MENTEE', data: Record<string, unknown>) => {
      const u = await seedUser(uniqueEmail(`sugg-rules-${role.toLowerCase()}`), 'x', role, name, org.id);
      await prisma.user.update({ where: { id: u.id }, data });
      return u;
    };
    const skill = `Pyth${stamp.replace(/[^a-z0-9]/gi, '')}`;
    // Data mentor carries one mentee already, so without the request the
    // lighter General mentor ranks first on the tie.
    const data = await mk('Data Mentor', 'MENTOR', { skills: [skill], interests: 'data science pipelines' });
    const general = await mk('General Mentor', 'MENTOR', { skills: [skill], interests: 'web design' });
    const paused = await mk('Paused Mentor', 'MENTOR', { skills: [skill], acceptingMentees: false });
    const busyMentee = await mk('Busy Mentee', 'MENTEE', {});
    await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: data.id, menteeId: busyMentee.id, status: 'ACTIVE' } });
    const mentee = await mk('Rules Mentee', 'MENTEE', { skills: [skill] });
    const request = await prisma.mentorshipRequest.create({
      data: { menteeId: mentee.id, preferredField: 'Data Science', preferredMentorId: general.id, message: 'Looking for help' },
    });

    expect((await signInViaApi(api, adminEmail, pw)).ok).toBe(true);
    type Body = {
      aiUsed: boolean; ruleSetId: string | null; ruleSetVersion: number; blockedTotal: number; preferredMentorId: string | null;
      suggestions: { mentorId: string; score: number; match: { score: number; breakdown: { dimension: string }[]; blockedBy: string[] } }[];
      blocked: { mentorId: string; match: { blockedBy: string[] } }[];
    };
    const suggest = async (extra: Record<string, unknown> = {}) => {
      const res = await api.post('/api/admin/mentor-suggest', { data: { menteeId: mentee.id, ...extra } });
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()) as Body;
    };

    const plain = await suggest();
    expect(plain.aiUsed).toBe(false);
    expect([plain.ruleSetId, plain.ruleSetVersion]).toEqual([ruleSet.id, 4]);
    // (the org's admin mentors too and trails with no skills — ADMINs are in the pool)
    expect(plain.suggestions.slice(0, 2).map((s) => s.mentorId)).toEqual([general.id, data.id]);
    expect(plain.suggestions[0].match.breakdown.map((e) => e.dimension)).toEqual(['skills', 'field', 'capacityHeadroom']);
    expect(plain.blocked).toEqual([expect.objectContaining({ mentorId: paused.id, match: expect.objectContaining({ blockedBy: ['capacityHeadroom'] }) })]);

    const withRequest = await suggest({ requestId: request.id });
    expect(withRequest.suggestions[0].mentorId).toBe(data.id);
    expect(withRequest.suggestions[0].score).toBeGreaterThan(withRequest.suggestions[1].score);
    expect(withRequest.preferredMentorId).toBe(general.id);

    // Somebody else's request id reads as missing.
    const other = await mk('Other Mentee', 'MENTEE', {});
    const otherReq = await prisma.mentorshipRequest.create({ data: { menteeId: other.id } });
    expect((await api.post('/api/admin/mentor-suggest', { data: { menteeId: mentee.id, requestId: otherReq.id } })).status()).toBe(404);
    await prisma.mentorshipRequest.delete({ where: { id: otherReq.id } });

    // The queue: Suggest shows the scored list, the preferred mentor stays picked.
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, '/admin/mentorship');
    const row = page.getByTestId(`request-${request.id}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByTestId(`request-suggest-${request.id}`).click();
    const list = row.getByTestId(`request-suggestions-${request.id}`);
    await expect(list.getByTestId(`request-suggestion-${data.id}`).getByTestId('match-score-compact')).toBeVisible();
    await expect(list.getByTestId(`request-suggestions-blocked-${request.id}`)).toBeVisible();
    await expect(row.locator('select')).toHaveValue(general.id);
    await list.getByTestId(`request-use-${data.id}`).click();
    await expect(row.locator('select')).toHaveValue(data.id);
  } finally {
    await api.dispose();
    await prisma.matchFeedback.deleteMany({ where: { orgId: org.id } });
    const users = await prisma.user.findMany({ where: { orgId: org.id }, select: { id: true } });
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId: { in: users.map((u) => u.id) } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.matchRuleSet.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
