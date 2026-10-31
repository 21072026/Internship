import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #3424: an org attribute (directory data — here a site) is offered in the
// rule editor, can be weighted, and flips who is suggested; an attribute this
// org does not have is refused at the save; the editor and the dry-run
// breakdown name it by its label. Its own org.
test('a weighted org attribute flips the ranking; an unknown one is refused', async ({ page }) => {
  test.slow();
  const request = page.request;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'AttrMatch123!';
  const org = await prisma.organization.create({ data: { name: `Attr Match ${stamp}`, slug: `attr-match-${stamp}` } });
  try {
    const adminEmail = uniqueEmail('atm-admin');
    await seedUser(adminEmail, pw, 'ADMIN', 'ATM Admin', org.id);
    const mentee = await seedUser(uniqueEmail('atm-mentee'), 'x', 'MENTEE', 'ATM Mentee', org.id);
    const skilled = await seedUser(uniqueEmail('atm-skilled'), 'x', 'MENTOR', 'Skilled Mentor', org.id);
    const sameSite = await seedUser(uniqueEmail('atm-site'), 'x', 'MENTOR', 'Same Site Mentor', org.id);
    await prisma.user.update({ where: { id: mentee.id }, data: { skills: ['Kotlin'] } });
    await prisma.user.update({ where: { id: skilled.id }, data: { skills: ['Kotlin'] } });

    const site = await prisma.orgAttribute.create({ data: { orgId: org.id, key: 'site', labelEn: 'Site', labelTr: 'Lokasyon', labelDe: 'Standort', type: 'SELECT', options: ['Berlin', 'Köln'] } });
    await prisma.userAttributeValue.createMany({
      data: [
        { orgId: org.id, userId: mentee.id, attributeId: site.id, value: 'Berlin' },
        { orgId: org.id, userId: skilled.id, attributeId: site.id, value: 'Köln' },
        { orgId: org.id, userId: sameSite.id, attributeId: site.id, value: 'Berlin' },
      ],
    });

    expect((await signInViaApi(request, adminEmail, pw)).ok).toBe(true);
    const listed = await (await request.get('/api/admin/matching/rule-sets')).json();
    expect(listed.attributes.map((a: { key: string }) => a.key)).toEqual(['site']);
    const refused = await request.post('/api/admin/matching/rule-sets', { data: { name: 'x', rules: [{ dimension: 'attribute:nope', kind: 'WEIGHTED', weight: 50 }] } });
    expect([refused.status(), (await refused.json()).code]).toEqual([400, 'unknown_attribute']);

    const simulate = async (rules: object[]) => {
      const res = await request.post('/api/admin/matching/simulate', { data: { ruleSet: { name: 'draft', rules }, menteeId: mentee.id } });
      expect(res.ok(), await res.text()).toBe(true);
      return ((await res.json()) as { results: { top: { mentorId: string }[] }[] }).results[0].top.map((t) => t.mentorId);
    };
    expect((await simulate([{ dimension: 'skills', kind: 'WEIGHTED', weight: 100, config: {} }]))[0]).toBe(skilled.id);
    const weighted = [
      { dimension: 'skills', kind: 'WEIGHTED', weight: 20, config: {} },
      { dimension: 'attribute:site', kind: 'WEIGHTED', weight: 80, config: {} },
    ];
    expect((await simulate(weighted))[0]).toBe(sameSite.id);
    // "A mentor from a different site" turns it round again.
    expect((await simulate([weighted[0], { ...weighted[1], config: { attributeMode: 'different' } }]))[0]).toBe(skilled.id);

    const saved = await request.post('/api/admin/matching/rule-sets', { data: { name: 'Same site', rules: [weighted[1]] } });
    expect(saved.status(), await saved.text()).toBe(201);
    const { ruleSet } = await saved.json();
    await gotoSettled(page, '/admin/matching');
    await page.getByTestId(`matching-set-${ruleSet.id}`).click();
    await expect(page.getByTestId('matching-rule-dimension-0').locator('option:checked')).toHaveText('Attribute: Site');
    await expect(page.getByTestId('matching-rule-attribute-mode-0')).toHaveValue('same');
    await page.getByTestId('matching-simulate').click();
    await expect(page.getByTestId('matching-sim-result')).toContainText('Attribute: Site', { timeout: 30_000 });
    await expect(page.getByTestId('matching-sim-result')).not.toContainText('attribute:');
  } finally {
    await prisma.matchRuleSet.deleteMany({ where: { orgId: org.id } });
    await prisma.userAttributeValue.deleteMany({ where: { orgId: org.id } });
    await prisma.orgAttribute.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
