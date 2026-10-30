import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// Admin-defined questions on the profile (#1803, slice 1). Its own org.
//   • a published MENTEE/PROFILE form appears on /portal/profile and nowhere
//     it was not defined for (a mentor is not asked it);
//   • a required question blocks the save until answered; the answer saves,
//     reloads, and survives a version bump of the form;
//   • clearing an optional answer removes it;
//   • a user writes only their OWN answers: a body naming a userId is
//     refused, and another org's form is 404.

const PW = 'CustomFields123!';
const L = (en: string) => ({ en, tr: `${en} (tr)`, de: `${en} (de)` });

test.describe('custom fields on the profile', () => {
  const stamp = `${Date.now()}`;
  const mentee = uniqueEmail('cf-mentee');
  const other = uniqueEmail('cf-other');
  const mentor = uniqueEmail('cf-mentor');
  let orgId = '';
  let otherOrgId = '';
  let menteeId = '';
  let otherId = '';
  let formId = '';
  let foreignFormId = '';

  const fields = [
    { key: 'industry', type: 'SELECT', labels: L('Target industry'), required: true, sortOrder: 0, options: [{ value: 'fin', labels: L('Finance') }, { value: 'health', labels: L('Health') }] },
    { key: 'remote', type: 'BOOLEAN', labels: L('Open to remote'), required: false, sortOrder: 1 },
  ];

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `CF Org ${stamp}`, slug: `cf-${stamp}` } })).id;
    otherOrgId = (await prisma.organization.create({ data: { name: `CF Other ${stamp}`, slug: `cf-o-${stamp}` } })).id;
    menteeId = (await seedUser(mentee, PW, 'MENTEE', `CF Mentee ${stamp}`, orgId)).id;
    otherId = (await seedUser(other, PW, 'MENTEE', `CF Other ${stamp}`, orgId)).id;
    await seedUser(mentor, PW, 'MENTOR', `CF Mentor ${stamp}`, orgId);
    formId = (
      await prisma.formDefinition.create({
        data: { orgId, key: 'mentee_profile', audience: 'MENTEE', surface: 'PROFILE', version: 1, title: L('About your goals'), publishedAt: new Date(), fields: { create: fields } },
      })
    ).id;
    foreignFormId = (
      await prisma.formDefinition.create({
        data: { orgId: otherOrgId, key: 'mentee_profile', audience: 'MENTEE', surface: 'PROFILE', version: 1, publishedAt: new Date(), fields: { create: fields } },
      })
    ).id;
  });

  test.afterAll(async () => {
    await prisma.formDefinition.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    for (const email of [mentee, other, mentor]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.$disconnect();
  });

  test('a mentee answers the profile questions; answers reload and survive a new version', async ({ page }) => {
    test.slow();
    await signInAndSettle(page, mentee, PW, '/portal');
    await gotoSettled(page, '/portal/profile');
    const section = page.getByTestId('dynamic-fields');
    await expect(section.getByText('About your goals')).toBeVisible({ timeout: 60_000 });
    await expect(section.getByText('Target industry')).toBeVisible();

    // The required question is checked first: nothing is saved without it.
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect(page.getByTestId('custom-field-industry-error')).toBeVisible();
    expect(await prisma.formResponse.count({ where: { userId: menteeId } })).toBe(0);

    await page.getByTestId('custom-field-industry').selectOption('health');
    await page.getByTestId('custom-field-remote').getByRole('radio', { name: 'Yes' }).click();
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect.poll(() => prisma.formResponse.count({ where: { userId: menteeId } })).toBe(2);

    // A new version of the form: the answer, keyed by field, still reads.
    const now = new Date();
    await prisma.formDefinition.update({ where: { id: formId }, data: { archivedAt: now } });
    const v2 = await prisma.formDefinition.create({
      data: { orgId, key: 'mentee_profile', audience: 'MENTEE', surface: 'PROFILE', version: 2, title: L('About your goals'), publishedAt: now, fields: { create: fields } },
    });
    await gotoSettled(page, '/portal/profile');
    await expect(page.getByTestId('custom-field-industry')).toHaveValue('health', { timeout: 60_000 });
    await expect(page.getByTestId('custom-field-remote').getByRole('radio', { name: 'Yes' })).toHaveAttribute('aria-checked', 'true');

    // Clearing an optional answer removes it — across versions, so it does not resurface.
    const cleared = await page.request.put('/api/forms/responses', { data: { definitionId: v2.id, answers: { industry: 'health', remote: null } } });
    expect(cleared.status()).toBe(200);
    expect(await prisma.formResponse.count({ where: { userId: menteeId, fieldKey: 'remote' } })).toBe(0);
    expect((await (await page.request.get('/api/forms/responses?surface=PROFILE')).json()).answers).toEqual({ mentee_profile: { industry: 'health' } });

    // The questions endpoint never carries answers or the matchable flag.
    const active = await (await page.request.get('/api/forms/active?surface=PROFILE')).json();
    expect(active.forms.map((f: { id: string }) => f.id)).toEqual([v2.id]);
    expect(Object.keys(active)).toEqual(['forms']);
    expect(JSON.stringify(active)).not.toContain('matchable');
  });

  test('answers are written only by their owner, only to a form they are asked', { tag: '@smoke' }, async ({ page }) => {
    await signInAndSettle(page, other, PW, '/portal');
    const live = (await (await page.request.get('/api/forms/active?surface=PROFILE')).json()).forms[0];
    // A body that names a user is refused outright — the person is the session.
    const forged = await page.request.put('/api/forms/responses', { data: { definitionId: live.id, userId: menteeId, answers: { industry: 'fin' } } });
    expect(forged.status()).toBe(400);
    expect(await prisma.formResponse.count({ where: { userId: menteeId, value: { equals: 'fin' } } })).toBe(0);
    // Another org's form is not found; a bad answer is the shared validator's refusal.
    expect((await page.request.put('/api/forms/responses', { data: { definitionId: foreignFormId, answers: { industry: 'fin' } } })).status()).toBe(404);
    const bad = await page.request.put('/api/forms/responses', { data: { definitionId: live.id, answers: { industry: 'nope' } } });
    expect([bad.status(), (await bad.json()).errors]).toEqual([400, { industry: 'not_an_option' }]);
    const ok = await page.request.put('/api/forms/responses', { data: { definitionId: live.id, answers: { industry: 'fin' } } });
    expect(ok.status()).toBe(200);
    expect(await prisma.formResponse.count({ where: { userId: otherId, fieldKey: 'industry' } })).toBe(1);
  });

  test('a mentor is not asked a mentee form', async ({ page }) => {
    await signInAndSettle(page, mentor, PW, '/mentor');
    expect((await (await page.request.get('/api/forms/active?surface=PROFILE')).json()).forms).toEqual([]);
    expect((await page.request.put('/api/forms/responses', { data: { definitionId: formId, answers: {} } })).status()).toBe(404);
    expect((await page.request.get('/api/forms/active?surface=NOPE')).status()).toBe(400);
  });
});
