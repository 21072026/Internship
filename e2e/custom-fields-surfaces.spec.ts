import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// Admin-defined questions on the remaining signed-in surfaces (#1803, slice 3a).
// Its own org.
//   • the onboarding wizard asks the ONBOARDING question and will not finish
//     without a required answer;
//   • the request panel asks the MENTORSHIP_REQUEST question; the answer is
//     saved with the request;
//   • the admin detail view shows the answers as option labels; another org's
//     admin gets 404, a mentor 403.

const PW = 'SurfacesPass123!';
const L = (en: string) => ({ en, tr: `${en} (tr)`, de: `${en} (de)` });

test.describe('custom fields on onboarding, the request panel and the admin view', () => {
  const stamp = `${Date.now()}`;
  const mentee = uniqueEmail('cfs-mentee');
  const admin = uniqueEmail('cfs-admin');
  const otherAdmin = uniqueEmail('cfs-other-admin');
  const mentor = uniqueEmail('cfs-mentor');
  let orgId = '';
  let otherOrgId = '';
  let menteeId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `CFS Org ${stamp}`, slug: `cfs-${stamp}` } })).id;
    otherOrgId = (await prisma.organization.create({ data: { name: `CFS Other ${stamp}`, slug: `cfs-o-${stamp}` } })).id;
    menteeId = (await seedUser(mentee, PW, 'MENTEE', `CFS Mentee ${stamp}`, orgId)).id;
    await seedUser(admin, PW, 'ADMIN', `CFS Admin ${stamp}`, orgId);
    await seedUser(otherAdmin, PW, 'ADMIN', `CFS Other ${stamp}`, otherOrgId);
    await seedUser(mentor, PW, 'MENTOR', `CFS Mentor ${stamp}`, orgId);
    // Everything the onboarding gate and the wizard need, so only the question is open.
    await prisma.user.update({ where: { id: menteeId }, data: { university: 'Test University', department: 'CS', graduationYear: 2025, skills: ['React'] } });
    const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
    await prisma.cvFile.create({ data: { userId: menteeId, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf } });

    const form = (key: string, surface: string, fields: object[]) =>
      prisma.formDefinition.create({ data: { orgId, key, audience: 'MENTEE', surface, version: 1, title: L(key), publishedAt: new Date(), fields: { create: fields as never } } });
    await form('mentee_onboarding', 'ONBOARDING', [
      { key: 'goal', type: 'SELECT', labels: L('Main goal'), required: true, sortOrder: 0, options: [{ value: 'job', labels: L('Find a job') }, { value: 'learn', labels: L('Learn') }] },
    ]);
    await form('mentee_request', 'MENTORSHIP_REQUEST', [
      { key: 'hours', type: 'NUMBER', labels: L('Hours per week'), required: true, sortOrder: 0 },
    ]);
  });

  test.afterAll(async () => {
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId } });
    await prisma.formDefinition.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    for (const email of [mentee, admin, otherAdmin, mentor]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.$disconnect();
  });

  test('onboarding and the request panel ask their questions; the admin reads the answers', async ({ page }) => {
    test.slow();
    await signInAndSettle(page, mentee, PW, '/portal');

    // Onboarding: the required question holds the last step.
    await gotoSettled(page, '/onboarding');
    await expect(page.getByLabel(/Full Name/i)).toHaveValue(`CFS Mentee ${stamp}`, { timeout: 60_000 });
    await page.getByRole('button', { name: /Continue/i }).click();
    await page.getByRole('button', { name: /Continue/i }).click();
    await expect(page.getByTestId('dynamic-fields').getByText('Main goal')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /Complete/i }).click();
    await expect(page.getByTestId('custom-field-goal-error')).toBeVisible();
    await page.getByTestId('custom-field-goal').selectOption('job');
    await page.getByRole('button', { name: /Complete/i }).click();
    await page.waitForURL((u) => u.pathname === '/portal', { timeout: 60_000 });
    expect((await prisma.formResponse.findFirst({ where: { userId: menteeId, fieldKey: 'goal' } }))?.value).toBe('job');

    // The request panel: its own question, saved with the request.
    await gotoSettled(page, '/portal');
    const panel = page.getByTestId('mentorship-request');
    await expect(panel.getByText('Hours per week')).toBeVisible({ timeout: 60_000 });
    await panel.getByTestId('request-submit').click();
    await expect(panel.getByTestId('custom-field-hours-error')).toBeVisible();
    expect(await prisma.mentorshipRequest.count({ where: { menteeId } })).toBe(0);
    await panel.getByTestId('custom-field-hours').fill('6');
    await panel.getByTestId('request-submit').click();
    await expect.poll(() => prisma.mentorshipRequest.count({ where: { menteeId } }), { timeout: 30_000 }).toBe(1);
    expect((await prisma.formResponse.findFirst({ where: { userId: menteeId, fieldKey: 'hours' } }))?.value).toBe(6);

    // The admin reads both answers on the candidate page, as labels.
    await page.context().clearCookies();
    await signInAndSettle(page, admin, PW, '/admin');
    await gotoSettled(page, `/admin/candidates/${menteeId}`);
    const answers = page.getByTestId('form-answers-panel');
    await expect(answers.getByTestId('form-answer-goal')).toHaveText('Find a job', { timeout: 60_000 });
    await expect(answers.getByTestId('form-answer-hours')).toHaveText('6');
  });

  test('the answers route is admin-only and tenant-scoped', { tag: '@smoke' }, async ({ page }) => {
    await signInAndSettle(page, otherAdmin, PW, '/admin');
    expect((await page.request.get(`/api/admin/users/${menteeId}/form-answers`)).status()).toBe(404);
    await page.context().clearCookies();
    await signInAndSettle(page, mentor, PW, '/mentor');
    expect((await page.request.get(`/api/admin/users/${menteeId}/form-answers`)).status()).toBe(403);
  });
});
