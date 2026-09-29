import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// The marketing account import, run from the admin panel (#2552, with the
// #2554 columns). The CLI cannot run in the production container, so this
// panel is how the real customer table gets in — and what this spec pins is the
// promise the cutover checklist (docs/marketing-import.md) rests on:
//
//   1. the shipped sample file previews with the right report and writes
//      NOTHING; apply writes exactly what the preview said; a second apply of
//      the same file is all UNCHANGED;
//   2. the #2554 dates and external ids land where the reminders, the usage
//      feed and the cohort reports read them;
//   3. an INTERNSHIP org never sees the mode and the route answers it
//      403 `vertical_mismatch`; a MENTOR (a MARKETING rep) gets 403.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'MktImport123';
const FIXTURE = path.join(__dirname, '..', 'scripts', 'fixtures', 'marketing-accounts-sample.csv');
const ROUTE = '/api/admin/import/marketing-accounts';

async function marketingOrg(stamp: string) {
  const org = await prisma.organization.create({
    data: { name: `Import MKT ${stamp}`, slug: `import-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  const stages = templateStagePayload(preset, 'en').stages;
  await prisma.pipelineStage.createMany({
    data: stages.map((st) => ({
      orgId: org.id,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  return org;
}

async function cleanupOrg(orgId: string, emails: string[]) {
  const companies = await prisma.company.findMany({ where: { orgId }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  const relations = await prisma.mentorshipRelation.findMany({ where: { orgId }, select: { id: true } });
  await prisma.statusChange.deleteMany({ where: { relationId: { in: relations.map((r) => r.id) } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, companyId: { in: companyIds } } }).catch(() => {});
  for (const email of emails) await cleanupByEmail(email);
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { targetId: orgId } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}

async function counts(page: import('@playwright/test').Page) {
  const report = page.getByTestId('marketing-import-report');
  const out: Record<string, number> = {};
  for (const s of ['CREATE', 'UPDATE', 'UNCHANGED', 'SKIP', 'ERROR']) {
    out[s] = Number(await report.getByTestId(`marketing-import-count-${s}`).getAttribute('data-count'));
  }
  return out;
}

test('the sample file: preview writes nothing, apply lands it, a second apply is all UNCHANGED', async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await marketingOrg(stamp);
  const adminEmail = uniqueEmail('mkt-import-admin');
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Import Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });

  try {
    await signInAndSettle(page, adminEmail, PW, '/admin');
    await gotoSettled(page, '/admin/settings');

    // A MARKETING org opens the panel on its own product's import.
    await expect(page.getByTestId('import-mode-marketing')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('marketing-import-file').setInputFiles(FIXTURE);
    await expect(page.getByTestId('marketing-import-text')).toHaveValue(readFileSync(FIXTURE, 'utf8'));
    await expect(page.getByTestId('marketing-import-apply')).toBeDisabled();

    // 1. Preview.
    await page.getByTestId('marketing-import-preview').click();
    const report = page.getByTestId('marketing-import-report');
    await expect(report).toHaveAttribute('data-dry-run', 'true', { timeout: 30_000 });
    expect(await counts(page)).toEqual({ CREATE: 6, UPDATE: 0, UNCHANGED: 0, SKIP: 0, ERROR: 0 });
    // The two soft cases are in the attention list: a stage without a contact
    // (row 3) and a trial without an end date (row 6, #2554's default window).
    await expect(report.getByTestId('marketing-import-row-3')).toContainText('no primary contact e-mail');
    await expect(report.getByTestId('marketing-import-row-6')).toContainText('default trial window applies (30 days from the import day)');
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(0);
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id } })).toBe(0);

    // 2. Apply — the same request with writing on, after one confirmation.
    await expect(page.getByTestId('marketing-import-apply')).toBeEnabled();
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('marketing-import-apply').click();
    await expect(report).toHaveAttribute('data-dry-run', 'false', { timeout: 60_000 });
    expect(await counts(page)).toEqual({ CREATE: 6, UPDATE: 0, UNCHANGED: 0, SKIP: 0, ERROR: 0 });
    // An apply spends the preview: the next apply needs a fresh one.
    await expect(page.getByTestId('marketing-import-apply')).toBeDisabled();

    const companies = await prisma.company.findMany({ where: { orgId: org.id }, select: { name: true, externalId: true } });
    expect(companies).toHaveLength(6);
    expect(companies.filter((c) => c.externalId).length).toBe(5);
    const relations = await prisma.mentorshipRelation.findMany({
      where: { orgId: org.id },
      select: { pipelineStatus: true, mentorId: true, trialStartedAt: true, trialEndsAt: true, startDate: true, company: { select: { name: true } } },
    });
    // Rows 1, 2, 4, 5 and 6 carry a contact; row 3 does not and places no record.
    expect(relations).toHaveLength(5);
    for (const r of relations) expect(r.mentorId).toBe(admin.id);
    const byName = Object.fromEntries(relations.map((r) => [r.company?.name, r]));
    const kaya = byName['Kaya Elektronik Ltd. Şti.'];
    expect(kaya.pipelineStatus).toBe('TRIAL_ACTIVE');
    expect(kaya.trialStartedAt?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(kaya.trialEndsAt?.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(kaya.startDate.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    const weber = byName['Weber Werkzeuge KG'];
    expect(weber.trialEndsAt).not.toBeNull();
    expect(weber.trialEndsAt!.getTime() - weber.trialStartedAt!.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(byName['Grüße Süßwaren GmbH'].startDate.toISOString()).toBe('2025-02-10T00:00:00.000Z');

    // Counts only in the activity log — no name, no address.
    const logged = await prisma.activityLog.findMany({ where: { action: 'marketing.accounts.imported', targetId: org.id } });
    expect(logged).toHaveLength(1);
    expect(logged[0].actorId).toBe(admin.id);
    expect(logged[0].detail).toMatch(/^rows=6 CREATE=6 UPDATE=0 UNCHANGED=0 SKIP=0 ERROR=0$/);

    // 3. The re-check the guide asks for: preview again, then apply again —
    // every row UNCHANGED, and nothing new in the database.
    await page.getByTestId('marketing-import-preview').click();
    await expect(report).toHaveAttribute('data-dry-run', 'true', { timeout: 30_000 });
    await expect(report.getByTestId('marketing-import-count-UNCHANGED')).toHaveAttribute('data-count', '6');
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('marketing-import-apply').click();
    await expect(report).toHaveAttribute('data-dry-run', 'false', { timeout: 60_000 });
    expect(await counts(page)).toEqual({ CREATE: 0, UPDATE: 0, UNCHANGED: 6, SKIP: 0, ERROR: 0 });
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(6);
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id } })).toBe(5);
    expect(await prisma.statusChange.count({ where: { relation: { orgId: org.id } } })).toBe(0);
  } finally {
    await cleanupOrg(org.id, [adminEmail]);
  }
});

test('INTERNSHIP never sees the mode and gets 403 vertical_mismatch; a MARKETING rep gets 403', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const internship = await prisma.organization.create({
    data: { name: `Import INT ${stamp}`, slug: `import-int-${stamp}`, vertical: 'INTERNSHIP' },
  });
  const marketing = await marketingOrg(`m-${stamp}`);
  const intAdminEmail = uniqueEmail('mkt-import-int-admin');
  const repEmail = uniqueEmail('mkt-import-rep');
  const intAdmin = await seedUser(intAdminEmail, PW, 'ADMIN', 'Internship Admin');
  await prisma.user.update({ where: { id: intAdmin.id }, data: { orgId: internship.id } });
  const rep = await seedUser(repEmail, PW, 'MENTOR', 'Marketing Rep');
  await prisma.user.update({ where: { id: rep.id }, data: { orgId: marketing.id } });

  const body = { text: readFileSync(FIXTURE, 'utf8') };
  try {
    await signInAndSettle(page, intAdminEmail, PW, '/admin');
    await gotoSettled(page, '/admin/settings');
    // The mentee importer is there, the marketing mode is not.
    await expect(page.getByPlaceholder(/fullName,email/)).toBeVisible();
    await expect(page.getByTestId('import-mode-marketing')).toHaveCount(0);
    await expect(page.getByTestId('marketing-import')).toHaveCount(0);
    const intRes = await page.request.post(ROUTE, { data: body });
    expect(intRes.status()).toBe(403);
    expect((await intRes.json()).code).toBe('vertical_mismatch');

    // A MARKETING MENTOR lands on /sales (#2580).
    await signInAsFreshUser(page, repEmail, PW, '/sales');
    const repRes = await page.request.post(ROUTE, { data: { ...body, apply: true } });
    expect(repRes.status()).toBe(403);

    expect(await prisma.company.count({ where: { orgId: { in: [internship.id, marketing.id] } } })).toBe(0);
  } finally {
    await cleanupOrg(marketing.id, [repEmail]);
    await cleanupByEmail(intAdminEmail);
    await prisma.setting.deleteMany({ where: { orgId: internship.id } }).catch(() => {});
    await prisma.organization.delete({ where: { id: internship.id } }).catch(() => {});
  }
});
