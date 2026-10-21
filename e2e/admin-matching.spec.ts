import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// /admin/matching (#1783): rule sets are an admin's own org's, every edit bumps
// the version, archiving keeps the row, and the dry run scores an UNSAVED
// draft — two drafts rank the same mentee differently, and a dry run writes
// nothing. A fresh org keeps the mentor pool to exactly the people seeded here.
test('rule sets: create, edit, default, archive; the dry run ranks one mentee differently under two drafts', async ({ page }) => {
  const request = page.request;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'MatchingPass123';
  const org = await prisma.organization.create({ data: { name: `Matching ${stamp}`, slug: `matching-${stamp}` } });
  try {
    const adminEmail = uniqueEmail('match-admin');
    const mentorEmail = uniqueEmail('match-mentor-user');
    await seedUser(adminEmail, pw, 'ADMIN', 'Matching Admin', org.id);
    await seedUser(mentorEmail, pw, 'MENTOR', 'Plain Mentor', org.id);
    const mentee = await seedUser(uniqueEmail('match-mentee'), 'x', 'MENTEE', 'Sim Mentee', org.id);
    const skilled = await seedUser(uniqueEmail('match-skilled'), 'x', 'MENTOR', 'Skilled Busy Mentor', org.id);
    const local = await seedUser(uniqueEmail('match-local'), 'x', 'MENTOR', 'Local Mentor', org.id);
    await prisma.user.update({ where: { id: mentee.id }, data: { skills: ['Kotlin'], city: 'Bremen' } });
    await prisma.user.update({ where: { id: skilled.id }, data: { skills: ['Kotlin'], city: 'Graz' } });
    await prisma.user.update({ where: { id: local.id }, data: { skills: [], city: 'Bremen' } });

    // A non-admin is refused by the route itself.
    expect((await signInViaApi(request, mentorEmail, pw)).ok).toBe(true);
    expect((await request.get('/api/admin/matching/rule-sets')).status()).toBe(403);
    expect((await request.post('/api/admin/matching/simulate', { data: {} })).status()).toBe(403);

    expect((await signInViaApi(request, adminEmail, pw)).ok).toBe(true);
    const bySkills = { name: 'Skills first', rules: [{ dimension: 'skills', kind: 'WEIGHTED', weight: 100, config: {} }] };
    const byCity = { name: 'Same city', rules: [{ dimension: 'city', kind: 'WEIGHTED', weight: 100, config: {} }] };

    const simulate = async (ruleSet: object) => {
      const res = await request.post('/api/admin/matching/simulate', { data: { ruleSet, menteeId: mentee.id } });
      expect(res.ok()).toBe(true);
      return (await res.json()) as { results: { top: { mentorId: string }[] }[]; summary: { withEligible: number } };
    };
    // Unsaved drafts: no save happens before either run.
    const a = await simulate(bySkills);
    const b = await simulate(byCity);
    expect(a.results[0].top[0].mentorId).toBe(skilled.id);
    expect(b.results[0].top[0].mentorId).toBe(local.id);
    // An over-tight draft explains itself.
    const tight = await request.post('/api/admin/matching/simulate', {
      data: { ruleSet: { name: 'Tight', rules: [{ dimension: 'skills', kind: 'HARD_REQUIRE', weight: 0, config: {} }, { dimension: 'city', kind: 'HARD_REQUIRE', weight: 0, config: {} }] }, menteeId: mentee.id },
    });
    expect(tight.ok()).toBe(true);
    const tightBody = await tight.json();
    expect(tightBody.results[0].top).toEqual([]);
    expect(tightBody.results[0].mostEliminating).toEqual({ dimension: 'skills', count: 3 });
    expect(tightBody.summary.withEligible).toBe(0);
    // A dry run writes nothing.
    expect(await prisma.matchRuleSet.count({ where: { orgId: org.id } })).toBe(0);
    expect(await prisma.matchFeedback.count({ where: { menteeId: mentee.id } })).toBe(0);

    // Create, edit (version bump), default, archive.
    const created = await request.post('/api/admin/matching/rule-sets', { data: bySkills });
    expect(created.status()).toBe(201);
    const { ruleSet } = await created.json();
    expect(ruleSet).toMatchObject({ name: 'Skills first', version: 1, isDefault: false });
    const edited = await request.put('/api/admin/matching/rule-sets', { data: { id: ruleSet.id, ...byCity, isDefault: true } });
    expect(edited.ok()).toBe(true);
    expect((await edited.json()).ruleSet).toMatchObject({ name: 'Same city', version: 2, isDefault: true });
    // An unknown dimension is refused on write.
    expect((await request.post('/api/admin/matching/rule-sets', { data: { name: 'x', rules: [{ dimension: 'astrology', kind: 'WEIGHTED', weight: 1 }] } })).status()).toBe(400);

    await gotoSettled(page, '/admin/matching');
    await expect(page.getByTestId(`matching-set-${ruleSet.id}`)).toContainText('Same city');
    await page.getByTestId(`matching-set-${ruleSet.id}`).click();
    await page.getByTestId('matching-simulate').click();
    await expect(page.getByTestId('matching-sim-summary')).toBeVisible();

    expect((await request.delete(`/api/admin/matching/rule-sets/${ruleSet.id}`)).ok()).toBe(true);
    const row = await prisma.matchRuleSet.findUniqueOrThrow({ where: { id: ruleSet.id } });
    expect(row.archivedAt).not.toBeNull();
    expect(row.isDefault).toBe(false);
    // Archived: still there, no longer listed, no longer editable.
    const list = await (await request.get('/api/admin/matching/rule-sets')).json();
    expect(list.ruleSets.map((r: { id: string }) => r.id)).not.toContain(ruleSet.id);
    expect((await request.put('/api/admin/matching/rule-sets', { data: { id: ruleSet.id, name: 'again' } })).status()).toBe(404);
  } finally {
    await prisma.matchRuleSet.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
