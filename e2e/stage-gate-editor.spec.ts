import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// Stage gates from the admin UI (#1590). A FREE tenant's admin sets an entry
// gate in the stage editor — gates are never paywalled, only the stage set's
// look and shape is — and a mentor who drags a card into that stage gets a
// dialog naming the missing document, in their own language, with a link to
// where it is uploaded. The card stays where it was.

test.afterAll(async () => prisma.$disconnect());
test.use({ viewport: { width: 1280, height: 900 } });

const PW = 'GateEditor123!';

test('a FREE admin sets a gate; a blocked mentor sees what is missing', { tag: '@smoke' }, async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const s = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `GateUI ${s}`, slug: `gateui-${s}`, plan: 'FREE' } });
  const emails = ['ge-admin', 'ge-mentor', 'ge-mentee'].map((p) => uniqueEmail(p));
  const [adminEmail, mentorEmail, menteeEmail] = emails;
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'Gate Editor Admin', org.id);
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Gate Editor Mentor', org.id);
    const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Gated Gizem', org.id);
    const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id } });
    await prisma.documentRequirement.create({
      data: { orgId: org.id, key: 'signed-agreement', labels: { en: 'Signed agreement', tr: 'İmzalı sözleşme', de: 'Unterschriebene Vereinbarung' }, appliesToStage: 'APPROVAL_PENDING_220', appliesToRole: 'MENTEE' },
    });

    // 1. The admin, on the FREE plan: shape locked, gates editable and saved.
    await signInAndSettle(page, adminEmail, PW, '/admin');
    await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await gotoSettled(page, `/admin/organizations/${org.id}/pipeline`);
    await expect(page.getByTestId('stage-label-APPROVAL_PENDING_220')).toBeDisabled();
    await page.getByTestId('stage-gate-documents-APPROVAL_PENDING_220').check();
    await page.getByTestId('pipeline-stages-save').click();
    await expect
      .poll(async () => (await prisma.pipelineStage.findFirst({ where: { orgId: org.id, key: 'APPROVAL_PENDING_220' } }))?.gateDocuments ?? false, { timeout: 15_000 })
      .toBe(true);
    // Only the gate moved: no label was frozen, and no other stage got a gate.
    expect(await prisma.pipelineStage.count({ where: { orgId: org.id, label: { not: '' } } })).toBe(0);
    expect(await prisma.pipelineStage.count({ where: { orgId: org.id, gateDocuments: true } })).toBe(1);
    // The look and shape stay a paid customisation.
    const stagesNow = (await (await page.request.get(`/api/admin/organizations/${org.id}/pipeline-stages`)).json()).stages as { key: string; label: string; order: number }[];
    const renamed = await page.request.put(`/api/admin/organizations/${org.id}/pipeline-stages`, {
      data: { stages: stagesNow.map((st, i) => (i === 0 ? { ...st, label: 'Renamed' } : st)) },
    });
    expect(renamed.status()).toBe(403);
    expect((await renamed.json()).code).toBe('plan_required');

    // 2. The mentor drags the card into the gated stage.
    const mentorContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const mentorPage = await mentorContext.newPage();
    await signInAndSettle(mentorPage, mentorEmail, PW, '/mentor');
    await mentorContext.addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await gotoSettled(mentorPage, '/mentor/board');
    await expect(mentorPage.getByTestId('board-columns')).toBeVisible({ timeout: 20_000 });
    await mentorPage.getByTestId('board-card').filter({ hasText: 'Gated Gizem' }).dragTo(mentorPage.getByTestId('board-column-APPROVAL_PENDING_220'));

    const dialog = mentorPage.getByTestId('stage-gate-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('data-code', 'documents');
    await expect(dialog.getByTestId('stage-gate-reason')).toHaveText('These required documents are still missing:');
    await expect(dialog.getByTestId('stage-gate-missing').getByText('Signed agreement', { exact: true })).toBeVisible();
    await expect(dialog.getByTestId('stage-gate-documents-link')).toHaveAttribute('href', `/mentor/mentees/${relation.id}#documents`);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).pipelineStatus).toBe('APPLICATION_100');
    await dialog.getByTestId('stage-gate-close').click();
    await expect(dialog).toHaveCount(0);

    // 3. The same refusal, in Turkish.
    await mentorContext.addCookies([{ name: 'locale', value: 'tr', url: baseURL! }]);
    await gotoSettled(mentorPage, '/mentor/board');
    await expect(mentorPage.getByTestId('board-columns')).toBeVisible({ timeout: 20_000 });
    await mentorPage.getByTestId('board-card').filter({ hasText: 'Gated Gizem' }).dragTo(mentorPage.getByTestId('board-column-APPROVAL_PENDING_220'));
    await expect(mentorPage.getByTestId('stage-gate-dialog').getByTestId('stage-gate-reason')).toHaveText('Şu zorunlu belgeler hâlâ eksik:');
    await expect(mentorPage.getByTestId('stage-gate-missing').getByText('İmzalı sözleşme', { exact: true })).toBeVisible();
    await mentorContext.close();
  } finally {
    for (const e of emails) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
