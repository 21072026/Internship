import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// One lead / account typed in by hand in a MARKETING org (#2562).
//
// The form on /admin/companies posts ONE row through the marketing import's own
// writer (POST /api/admin/marketing-accounts, create-only). So what this spec
// pins is the product promise, end to end:
//
//   1. the lead lands in all three places a salesperson looks — the account
//      list, the board at the org's FIRST stage (the MARKETING preset's, not
//      the internship default), and the lead's own detail page;
//   2. a second attempt with the same VAT id creates nothing and answers
//      "already exists" with a way to the existing account — the import's
//      match key, not a second one;
//   3. an INTERNSHIP org never sees the form and the route refuses it, and a
//      MENTEE or COMPANY caller is refused whatever the vertical.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'ManualLead123';

async function marketingOrg(stamp: string) {
  const org = await prisma.organization.create({
    data: { name: `Manual MKT ${stamp}`, slug: `manual-mkt-${stamp}`, vertical: 'MARKETING' },
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
  const first = [...stages].filter((s) => !s.isOffPath).sort((a, b) => a.order - b.order)[0];
  return { org, firstStage: first };
}

async function cleanupOrg(orgId: string, emails: string[]) {
  const companies = await prisma.company.findMany({ where: { orgId }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  const leads = await prisma.user.findMany({ where: { orgId, companyId: { in: companyIds } }, select: { id: true } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: leads.map((l) => l.id) } } }).catch(() => {});
  for (const email of emails) await cleanupByEmail(email);
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { targetId: { in: companyIds } } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}

async function fillLead(page: Page, fields: { name: string; country: string; vat: string; contact: string; email: string }) {
  const dialog = page.getByTestId('new-lead-dialog');
  await dialog.locator('#new-lead-name').fill(fields.name);
  await dialog.locator('#new-lead-country').fill(fields.country);
  await dialog.locator('#new-lead-vat').fill(fields.vat);
  await dialog.locator('#new-lead-contact-name').fill(fields.contact);
  await dialog.locator('#new-lead-contact-email').fill(fields.email);
  await dialog.locator('#new-lead-source').fill('Trade fair');
  await dialog.getByTestId('new-lead-submit').click();
}

test('a MARKETING admin creates a lead by hand; the same VAT a second time creates nothing', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const { org, firstStage } = await marketingOrg(stamp);
  const adminEmail = uniqueEmail('manual-lead-admin');
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Manual Lead Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });

  const accountName = `Fairground Handel ${stamp}`;
  const contactName = `Fiona Fair ${stamp}`;
  const contactEmail = uniqueEmail('fiona');
  const vat = `DE${String(Date.now()).slice(-9)}`;

  try {
    // A MARKETING-org account only has a session on the marketing host (#2590):
    // the header stays on the context for every navigation and page.request below.
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, adminEmail, PW, '/admin');
    await gotoSettled(page, '/admin/companies');

    await page.getByTestId('new-lead-button').click();
    const dialog = page.getByTestId('new-lead-dialog');
    await expect(dialog).toBeVisible();
    // The starting stage defaults to the org's own first on-path stage.
    await expect(dialog.getByTestId('new-lead-stage')).toHaveValue(firstStage.key);

    await fillLead(page, { name: accountName, country: 'de', vat: `${vat.slice(0, 2)} ${vat.slice(2)}`, contact: contactName, email: contactEmail });
    await expect(dialog.getByTestId('new-lead-created')).toBeVisible({ timeout: 20_000 });

    // One account, one lead on a stand-in address, one funnel record at the first stage.
    const company = await prisma.company.findFirstOrThrow({ where: { orgId: org.id, vatId: vat } });
    expect(company.country).toBe('DE');
    expect(company.contactEmail).toBe(contactEmail);
    const relation = await prisma.mentorshipRelation.findFirstOrThrow({
      where: { companyId: company.id },
      include: { mentee: { select: { email: true, fullName: true, referralSource: true } } },
    });
    expect(relation.pipelineStatus).toBe(firstStage.key);
    expect(relation.mentorId).toBe(admin.id);
    expect(relation.mentee.fullName).toBe(contactName);
    expect(relation.mentee.email).not.toBe(contactEmail);
    expect(relation.mentee.referralSource).toBe('Trade fair');
    expect(
      await prisma.activityLog.count({ where: { action: 'marketing.account.created', targetId: company.id } }),
    ).toBe(1);

    // 1. The account list behind the dialog was refreshed.
    await expect(page.getByTestId('companies-list').getByText(accountName, { exact: true })).toBeVisible();

    // 2. The lead detail page, through the dialog's own link.
    await dialog.getByTestId('new-lead-open-lead').click();
    await page.waitForURL(`**/admin/candidates/${relation.menteeId}`);
    await expect(page.getByText(contactName, { exact: true }).first()).toBeVisible({ timeout: 20_000 });

    // 3. The board, in the first stage's column.
    await gotoSettled(page, '/admin/board');
    await expect(
      page.getByTestId(`board-column-${firstStage.key}`).getByText(contactName, { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // Second attempt, same VAT (spelled differently), different name: nothing new.
    await gotoSettled(page, '/admin/companies');
    await page.getByTestId('new-lead-button').click();
    await fillLead(page, { name: `${accountName} Renamed`, country: 'DE', vat: vat.toLowerCase(), contact: contactName, email: contactEmail });
    await expect(dialog.getByTestId('new-lead-exists')).toBeVisible({ timeout: 20_000 });
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(1);
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id } })).toBe(1);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).name).toBe(accountName);

    // The admin's own address as the contact: staff is never a lead (409
    // contact_is_user), nothing is written and the admin's profile is untouched.
    const selfRes = await page.request.post('/api/admin/marketing-accounts', {
      data: { name: `Self Typed ${stamp}`, country: 'DE', contactEmail: adminEmail.toUpperCase() },
    });
    expect(selfRes.status()).toBe(409);
    expect((await selfRes.json()).code).toBe('contact_is_user');
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(1);
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: admin.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).companyId).toBeNull();

    // "Open existing account" opens that account's edit dialog.
    await dialog.getByTestId('new-lead-open-account').click();
    await expect(page.getByTestId('new-lead-dialog')).toHaveCount(0);
    await expect(page.locator('#company-form-title')).toBeVisible();
    await expect(page.locator('form input[name="name"]').first()).toHaveValue(accountName, { timeout: 20_000 });
  } finally {
    await cleanupOrg(org.id, [adminEmail]);
  }
});

test('INTERNSHIP never sees the form and the route refuses it; MENTEE and COMPANY get 403', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const internship = await prisma.organization.create({
    data: { name: `Manual INT ${stamp}`, slug: `manual-int-${stamp}`, vertical: 'INTERNSHIP' },
  });
  const { org: marketing } = await marketingOrg(`m-${stamp}`);
  const intAdminEmail = uniqueEmail('manual-int-admin');
  const menteeEmail = uniqueEmail('manual-mentee');
  const companyEmail = uniqueEmail('manual-company');
  const intAdmin = await seedUser(intAdminEmail, PW, 'ADMIN', 'Internship Admin');
  await prisma.user.update({ where: { id: intAdmin.id }, data: { orgId: internship.id } });
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Marketing Mentee');
  const account = await prisma.company.create({ data: { orgId: marketing.id, name: `Login Co ${stamp}` } });
  const companyUser = await seedUser(companyEmail, PW, 'COMPANY', 'Marketing Company Login');
  await prisma.user.update({ where: { id: mentee.id }, data: { orgId: marketing.id } });
  await prisma.user.update({ where: { id: companyUser.id }, data: { orgId: marketing.id, companyId: account.id } });

  const body = { name: `Refused ${stamp}`, contactEmail: uniqueEmail('refused') };
  try {
    await signInAndSettle(page, intAdminEmail, PW, '/admin');
    await gotoSettled(page, '/admin/companies');
    await expect(page.getByTestId('companies-search')).toBeVisible();
    await expect(page.getByTestId('new-lead-button')).toHaveCount(0);
    const intRes = await page.request.post('/api/admin/marketing-accounts', { data: body });
    expect(intRes.status()).toBe(403);
    expect((await intRes.json()).code).toBe('vertical_unavailable');

    // The MARKETING-org logins below only work on the marketing host (#2590);
    // the INTERNSHIP admin above stayed on the default one.
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    // A MARKETING lead has no mentee portal (#2351): /portal bounces it to
    // /account. Waiting on '/portal' only passed when the URL was caught
    // mid-bounce, which is why this read green locally and red on e2e-full.
    await signInAsFreshUser(page, menteeEmail, PW, '/account');
    expect((await page.request.post('/api/admin/marketing-accounts', { data: body })).status()).toBe(403);

    await signInAsFreshUser(page, companyEmail, PW, '/company');
    expect((await page.request.post('/api/admin/marketing-accounts', { data: body })).status()).toBe(403);

    expect(await prisma.company.count({ where: { name: body.name } })).toBe(0);
  } finally {
    await prisma.user.update({ where: { id: companyUser.id }, data: { companyId: null } }).catch(() => {});
    await cleanupOrg(marketing.id, [menteeEmail, companyEmail]);
    await cleanupByEmail(intAdminEmail);
    await prisma.setting.deleteMany({ where: { orgId: internship.id } }).catch(() => {});
    await prisma.organization.delete({ where: { id: internship.id } }).catch(() => {});
  }
});

// The lead page is the internship candidate page (#2348): its offer, evaluation,
// goals, meeting-cadence and certificate panels are internship modules and
// follow the shell's capabilities. A COMPLETED relation makes the certificate
// rule (canIssueCertificate) genuinely true, so its absence is the gate's doing.
const INTERNSHIP_PANELS = ['relation-cadence', 'offer-management-panel', 'evaluation-panel', 'goals-panel', 'certificate-card'];

async function completedPair(orgId: string, stamp: string, label: string) {
  const adminEmail = uniqueEmail(`${label}-panels-admin`);
  const leadEmail = uniqueEmail(`${label}-panels-lead`);
  const admin = await seedUser(adminEmail, PW, 'ADMIN', `${label} Panels Admin`);
  const lead = await seedUser(leadEmail, PW, 'MENTEE', `${label} Panels Lead ${stamp}`);
  await prisma.user.updateMany({ where: { id: { in: [admin.id, lead.id] } }, data: { orgId } });
  await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: admin.id, menteeId: lead.id, status: 'COMPLETED', completedAt: new Date() },
  });
  return { adminEmail, leadEmail, lead };
}

test('a MARKETING admin sees no internship panel on a lead; an INTERNSHIP admin sees all five', async ({ browser }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const { org: marketing } = await marketingOrg(`p-${stamp}`);
  const internship = await prisma.organization.create({
    data: { name: `Panels INT ${stamp}`, slug: `panels-int-${stamp}`, vertical: 'INTERNSHIP' },
  });
  const mkt = await completedPair(marketing.id, stamp, 'mkt');
  const int = await completedPair(internship.id, stamp, 'int');
  const mktContext = await browser.newContext({ extraHTTPHeaders: asHost(MARKETING_HOST) });
  const intContext = await browser.newContext();
  try {
    const mktPage = await mktContext.newPage();
    await signInAndSettle(mktPage, mkt.adminEmail, PW, '/admin');
    await gotoSettled(mktPage, `/admin/candidates/${mkt.lead.id}`);
    // The page itself rendered (the lead's name), so an absent panel is a gate,
    // not a page that never loaded.
    await expect(mktPage.getByText(`mkt Panels Lead ${stamp}`, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    for (const testId of INTERNSHIP_PANELS) {
      await expect(mktPage.getByTestId(testId), `${testId} on a MARKETING lead`).toHaveCount(0);
    }

    const intPage = await intContext.newPage();
    await signInAndSettle(intPage, int.adminEmail, PW, '/admin');
    await gotoSettled(intPage, `/admin/candidates/${int.lead.id}`);
    for (const testId of INTERNSHIP_PANELS) {
      await expect(intPage.getByTestId(testId).first(), `${testId} on an INTERNSHIP candidate`).toBeVisible({ timeout: 20_000 });
    }
  } finally {
    await mktContext.close();
    await intContext.close();
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: internship.id } }).catch(() => {});
    for (const e of [int.adminEmail, int.leadEmail]) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: internship.id } }).catch(() => {});
    await cleanupOrg(marketing.id, [mkt.adminEmail, mkt.leadEmail]);
  }
});
