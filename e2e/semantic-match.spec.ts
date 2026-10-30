import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The semantic rule end to end (#2038): with the org's rule set weighting
// `semanticAffinity`, a mentor who shares no literal skill with the mentee but
// shares their profile themes is suggested first, and the breakdown names the
// shared themes; setting the weight to 0 puts the old order back exactly. The
// digests are cached rows — a suggestion makes no provider call (none is
// configured here at all).
test('a keyword-less mentor ranks first on shared themes; weight 0 restores the order', async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'SemanticPass123!';
  const org = await prisma.organization.create({ data: { name: `Semantic ${stamp}`, slug: `semantic-${stamp}` } });
  const ruleSet = await prisma.matchRuleSet.create({
    data: {
      orgId: org.id, name: 'Skills + themes', isDefault: true, version: 2,
      rules: {
        create: [
          { orgId: org.id, dimension: 'skills', kind: 'WEIGHTED', weight: 40, sortOrder: 0, config: { mode: 'lowercase' } },
          { orgId: org.id, dimension: 'semanticAffinity', kind: 'WEIGHTED', weight: 60, sortOrder: 1 },
          { orgId: org.id, dimension: 'capacityHeadroom', kind: 'HARD_REQUIRE', weight: 0, sortOrder: 2 },
        ],
      },
    },
    include: { rules: true },
  });
  const api = await playwright.request.newContext({ baseURL });
  try {
    const adminEmail = uniqueEmail('semantic-admin');
    await seedUser(adminEmail, pw, 'ADMIN', 'Semantic Admin', org.id);
    const person = async (role: 'MENTOR' | 'MENTEE', name: string, skills: string[], themes: string[] | null) => {
      const u = await seedUser(uniqueEmail(`semantic-${role.toLowerCase()}`), pw, role, name, org.id);
      await prisma.user.update({ where: { id: u.id }, data: { skills } });
      if (themes) {
        await prisma.profileDigest.create({ data: { orgId: org.id, userId: u.id, digest: `${name} digest`, themes, sourceHash: 'test', model: 'test' } });
      }
      return u;
    };
    const mentee = await person('MENTEE', 'Switching Tester', ['Testing'], ['backend engineering', 'go', 'career switch']);
    const literal = await person('MENTOR', 'Literal Mentor', ['Testing'], ['quality assurance']);
    const semantic = await person('MENTOR', 'Platform Mentor', ['Kubernetes'], ['go', 'career switch', 'platform engineering']);

    expect((await signInViaApi(api, adminEmail, pw)).ok).toBe(true);
    type Body = { suggestions: { mentorId: string; score: number; match: { breakdown: { dimension: string; detail: string[]; contribution: number }[] } }[] };
    const suggest = async () => {
      const res = await api.post('/api/admin/mentor-suggest', { data: { menteeId: mentee.id } });
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()) as Body;
    };

    const weighted = await suggest();
    expect(weighted.suggestions[0].mentorId).toBe(semantic.id);
    const row = weighted.suggestions[0].match.breakdown.find((e) => e.dimension === 'semanticAffinity')!;
    expect(row.detail).toEqual(['go', 'career switch', 'backend engineering ≈ platform engineering']);
    expect(row.contribution).toBeGreaterThan(0);

    // Weight 0: the literal-skills order comes back, scores and all.
    const semRule = ruleSet.rules.find((r) => r.dimension === 'semanticAffinity')!;
    await prisma.matchRule.update({ where: { id: semRule.id }, data: { weight: 0 } });
    const off = await suggest();
    expect(off.suggestions[0].mentorId).toBe(literal.id);
    await prisma.matchRule.delete({ where: { id: semRule.id } });
    const without = await suggest();
    expect(off.suggestions.map((s) => [s.mentorId, s.score])).toEqual(without.suggestions.map((s) => [s.mentorId, s.score]));
  } finally {
    await api.dispose();
    await prisma.matchFeedback.deleteMany({ where: { orgId: org.id } });
    await prisma.matchRule.deleteMany({ where: { ruleSetId: ruleSet.id } });
    await prisma.matchRuleSet.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
