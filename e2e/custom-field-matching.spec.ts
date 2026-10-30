import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1803: an admin-defined SELECT question, answered by a mentee through the
// participant route and by two mentors, is offered in the rule editor, can be
// weighted, and changes who is suggested. A free-text question on the same
// form is neither offered nor accepted in a rule set. Its own org.
test('a matchable custom field, answered and weighted, changes the ranking', async ({ page }) => {
  test.slow();
  const request = page.request;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'CustomMatch123!';
  const L = (en: string) => ({ en, tr: `${en} (tr)`, de: `${en} (de)` });
  const org = await prisma.organization.create({ data: { name: `CF Match ${stamp}`, slug: `cf-match-${stamp}` } });
  try {
    const adminEmail = uniqueEmail('cfm-admin');
    const menteeEmail = uniqueEmail('cfm-mentee');
    await seedUser(adminEmail, pw, 'ADMIN', 'CFM Admin', org.id);
    const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'CFM Mentee', org.id);
    const skilled = await seedUser(uniqueEmail('cfm-skilled'), 'x', 'MENTOR', 'Skilled Mentor', org.id);
    const sameField = await seedUser(uniqueEmail('cfm-field'), 'x', 'MENTOR', 'Same Industry Mentor', org.id);
    await prisma.user.update({ where: { id: mentee.id }, data: { skills: ['Kotlin'] } });
    await prisma.user.update({ where: { id: skilled.id }, data: { skills: ['Kotlin'] } });

    const form = await prisma.formDefinition.create({
      data: {
        orgId: org.id,
        key: 'matching_profile',
        audience: 'BOTH',
        surface: 'PROFILE',
        version: 1,
        publishedAt: new Date(),
        fields: {
          create: [
            { key: 'industry', type: 'SELECT', labels: L('Industry'), matchable: true, sortOrder: 0, options: [{ value: 'fin', labels: L('Finance') }, { value: 'health', labels: L('Health') }] },
            { key: 'bio', type: 'LONG_TEXT', labels: L('About'), sortOrder: 1 },
          ],
        },
      },
    });
    // The mentors' answers, as the participant route would have stored them.
    await prisma.formResponse.createMany({
      data: [
        { orgId: org.id, userId: skilled.id, definitionId: form.id, fieldKey: 'industry', value: 'fin' },
        { orgId: org.id, userId: sameField.id, definitionId: form.id, fieldKey: 'industry', value: 'health' },
      ],
    });

    // The mentee answers through the participant route.
    expect((await signInViaApi(request, menteeEmail, pw)).ok).toBe(true);
    const answered = await request.put('/api/forms/responses', { data: { definitionId: form.id, answers: { industry: 'health', bio: 'I like hospitals' } } });
    expect(answered.status()).toBe(200);

    expect((await signInViaApi(request, adminEmail, pw)).ok).toBe(true);
    // Only the matchable question is offered.
    const listed = await (await request.get('/api/admin/matching/rule-sets')).json();
    expect(listed.customFields.map((f: { key: string }) => f.key)).toEqual(['industry']);
    // A rule over free text, or a question this org does not have, is refused.
    for (const dimension of ['customField:bio', 'customField:nope']) {
      const refused = await request.post('/api/admin/matching/rule-sets', { data: { name: 'x', rules: [{ dimension, kind: 'WEIGHTED', weight: 50 }] } });
      expect([refused.status(), (await refused.json()).code]).toEqual([400, 'not_matchable_field']);
    }

    const simulate = async (rules: object[]) => {
      const res = await request.post('/api/admin/matching/simulate', { data: { ruleSet: { name: 'draft', rules }, menteeId: mentee.id } });
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { results: { top: { mentorId: string }[] }[] }).results[0].top.map((t) => t.mentorId);
    };
    const skillsOnly = await simulate([{ dimension: 'skills', kind: 'WEIGHTED', weight: 100, config: {} }]);
    expect(skillsOnly[0]).toBe(skilled.id);
    const weighted = await simulate([
      { dimension: 'skills', kind: 'WEIGHTED', weight: 20, config: {} },
      { dimension: 'customField:industry', kind: 'WEIGHTED', weight: 80, config: {} },
    ]);
    expect(weighted[0]).toBe(sameField.id);

    // The weighted set saves, and the editor shows the question by its label.
    const saved = await request.post('/api/admin/matching/rule-sets', {
      data: { name: 'Industry first', rules: [{ dimension: 'customField:industry', kind: 'WEIGHTED', weight: 100, config: {} }] },
    });
    expect(saved.status()).toBe(201);
    const { ruleSet } = await saved.json();
    await gotoSettled(page, '/admin/matching');
    await page.getByTestId(`matching-set-${ruleSet.id}`).click();
    await expect(page.getByTestId('matching-rule-dimension-0').locator('option:checked')).toHaveText('Question: Industry');
  } finally {
    await prisma.matchRuleSet.deleteMany({ where: { orgId: org.id } });
    await prisma.formDefinition.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
