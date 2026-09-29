import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { PRIVACY_POLICY_VERSION } from '../src/lib/privacy';

// The demo form on the MARKETING landing (#2569) and the default lead owner
// (#2580 item 3).
//
// What this pins, end to end:
//   1. a request sent on the marketing host lands in the org that EXPLICITLY
//      claims that host (`Organization.publicHost`), with its consent record
//      (privacy text version + time), the unchecked product-news box and the
//      campaign parameters — and it is invisible to the internship tenant: not
//      in its list, not in its admins' notifications, not convertible by it;
//   2. with no default owner it waits, "unowned", until an admin adds it to the
//      pipeline, which is idempotent on a second click;
//   3. with a default owner it lands on that person's funnel by itself, and the
//      hand-typed lead route (#2562) reads the same setting;
//   4. a marketing host NO org claims is a closed form (fail-closed), never the
//      internship tenant's inbox.
//
// `MARKETING_HOSTS` defaults to marketing.bcsit-gmbh.de, so forging
// `x-forwarded-host` routes the marketing vertical without an env change (the
// host-vertical-* specs use the same trick). Every test also gets its own
// `x-forwarded-for`, because the form's rate limit (3/hour) is per client IP.
//
// Serial: `publicHost` is unique, and test 4 needs the host UNmapped.

test.describe.configure({ mode: 'serial' });

const MARKETING_HOST = 'marketing.bcsit-gmbh.de';
const PW = 'DemoForm123!';

let ipSeq = 0;
function clientIp() {
  ipSeq += 1;
  return `10.25.${Math.floor(Math.random() * 250)}.${(ipSeq % 250) + 1}`;
}

const stamp = `${Date.now()}-${Math.round(performance.now())}`;
let orgId = '';
let firstStage = '';
const mktAdminEmail = uniqueEmail('demo-form-mkt-admin');
const mktRepEmail = uniqueEmail('demo-form-mkt-rep');
const intAdminEmail = uniqueEmail('demo-form-int-admin');
let mktAdminId = '';
let mktRepId = '';
let intAdminId = '';
const inquiryEmails: string[] = [];

test.beforeAll(async () => {
  // A leftover mapping from a crashed run would make this host belong to an
  // org nobody here created.
  await prisma.organization.updateMany({ where: { publicHost: MARKETING_HOST }, data: { publicHost: null } });
  const org = await prisma.organization.create({
    data: { name: `Demo Form MKT ${stamp}`, slug: `demo-form-mkt-${stamp}`, vertical: 'MARKETING', publicHost: MARKETING_HOST },
  });
  orgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  const stages = templateStagePayload(preset, 'en').stages;
  await prisma.pipelineStage.createMany({
    data: stages.map((st) => ({
      orgId,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  firstStage = [...stages].filter((s) => !s.isOffPath).sort((a, b) => a.order - b.order)[0].key;

  const mktAdmin = await seedUser(mktAdminEmail, PW, 'ADMIN', 'Demo Form Marketing Admin');
  await prisma.user.update({ where: { id: mktAdmin.id }, data: { orgId } });
  mktAdminId = mktAdmin.id;
  const rep = await seedUser(mktRepEmail, PW, 'MENTOR', 'Demo Form Rep');
  await prisma.user.update({ where: { id: rep.id }, data: { orgId } });
  mktRepId = rep.id;
  // No org = the default (internship) org's admin, by the deploy backfill's rule.
  intAdminId = (await seedUser(intAdminEmail, PW, 'ADMIN', 'Demo Form Internship Admin')).id;
});

test.afterAll(async () => {
  const companies = await prisma.company.findMany({ where: { orgId }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await prisma.companyInquiry.deleteMany({ where: { email: { in: inquiryEmails } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, role: 'MENTEE' } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { userId: { in: [mktAdminId, mktRepId, intAdminId] } } }).catch(() => {});
  for (const email of [mktAdminEmail, mktRepEmail, intAdminEmail]) await cleanupByEmail(email);
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { targetId: { in: companyIds } } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

function newInquiryEmail(prefix: string) {
  const email = uniqueEmail(prefix);
  inquiryEmails.push(email);
  return email;
}

async function postInquiry(request: APIRequestContext, host: string, body: Record<string, unknown>) {
  return request.post('/api/company-inquiry', {
    headers: { 'x-forwarded-host': host, 'x-forwarded-for': clientIp() },
    data: { consent: true, renderedAt: Date.now() - 10_000, ...body },
  });
}

async function notificationsFor(userId: string, companyName: string) {
  return prisma.notification.count({
    where: { userId, type: 'signup.companyInquiry', params: { path: '$.companyName', equals: companyName } },
  });
}

async function openMarketingLanding(page: Page, path = '/') {
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': MARKETING_HOST, 'x-forwarded-for': clientIp() });
  await page.goto(path);
  await page.getByRole('button', { name: /Necessary only/i }).click().catch(() => {});
}

test('a request on the marketing host lands in the mapped MARKETING org, unowned, and nowhere else', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const companyName = `Bazaar Handel ${stamp}`;
  const email = newInquiryEmail('demo-form-lead');

  await openMarketingLanding(page, '/?utm_source=linkedin&utm_medium=social&utm_campaign=autumn-2026');
  const section = page.getByTestId('landing-demo-form');
  await expect(section.getByTestId('company-inquiry-form')).toBeVisible();
  // Internship fields are not on this form; the marketing ones are.
  await expect(section.getByText('Roles you are hiring for', { exact: false })).toHaveCount(0);
  await expect(section.getByTestId('inquiry-marketplaces')).toBeVisible();
  // The product-news box is separate and starts UNCHECKED.
  await expect(section.getByTestId('inquiry-marketing-optin')).not.toBeChecked();

  await section.locator('#company').fill(companyName);
  await section.locator('#your-name').fill('Mira Markt');
  await section.locator('#work-email').fill(email);
  await section.getByTestId('inquiry-marketplaces').fill('Amazon, Otto');
  await section.locator('#inquiry-message').fill('About 400 orders a month.');
  await section.getByTestId('inquiry-consent').check();
  // The server drops submits faster than 3s as bot traffic.
  await page.waitForTimeout(3200);
  await section.getByRole('button', { name: 'Request a demo' }).click();
  await expect(page.getByTestId('company-inquiry-success')).toBeVisible({ timeout: 20_000 });

  const row = await prisma.companyInquiry.findFirstOrThrow({ where: { email } });
  expect(row.orgId).toBe(orgId);
  expect(row.companyName).toBe(companyName);
  expect(row.openRoles).toBeNull();
  expect(row.marketplaces).toBe('Amazon, Otto');
  // The consent record: time AND text version, both server-side.
  expect(row.consentAt).not.toBeNull();
  expect(row.consentTextVersion).toBe(PRIVACY_POLICY_VERSION);
  expect(row.marketingOptIn).toBe(false);
  expect(row.utmSource).toBe('linkedin');
  expect(row.utmMedium).toBe('social');
  expect(row.utmCampaign).toBe('autumn-2026');
  expect(row.receivedHost).toBe(MARKETING_HOST);
  // No default owner → not on anybody's funnel yet.
  expect(row.convertedCompanyId).toBeNull();
  expect(row.status).toBe('NEW');

  // Only the target org's admins were told.
  expect(await notificationsFor(mktAdminId, companyName)).toBe(1);
  expect(await notificationsFor(intAdminId, companyName)).toBe(0);

  // The internship admin cannot see it, and cannot convert it.
  const intContext = await browser.newContext();
  const intPage = await intContext.newPage();
  try {
    await signInAndSettle(intPage, intAdminEmail, PW, '/admin');
    const list = await intPage.request.get('/api/admin/company-inquiries');
    expect(list.ok()).toBeTruthy();
    const ids = ((await list.json()).items as { id: string }[]).map((i) => i.id);
    expect(ids).not.toContain(row.id);
    const convert = await intPage.request.post(`/api/admin/company-inquiries/${row.id}/convert`, { data: {} });
    expect(convert.status()).toBe(404);
  } finally {
    await intContext.close();
  }

  // The marketing admin sees it marked unowned, and adds it to the pipeline.
  const mktContext = await browser.newContext();
  const mktPage = await mktContext.newPage();
  try {
    await signInAndSettle(mktPage, mktAdminEmail, PW, '/admin');
    await gotoSettled(mktPage, '/admin/company-inquiries');
    await expect(mktPage.getByRole('heading', { name: 'Demo requests' })).toBeVisible();
    await expect(mktPage.getByTestId(`inquiry-unowned-${row.id}`)).toBeVisible();
    await expect(mktPage.getByTestId(`inquiry-source-${row.id}`)).toContainText('linkedin');
    await mktPage.getByTestId(`convert-inquiry-${row.id}`).click();
    await expect(mktPage.getByTestId(`inquiry-converted-${row.id}`)).toBeVisible({ timeout: 20_000 });
    await expect(mktPage.getByTestId(`inquiry-unowned-${row.id}`)).toHaveCount(0);

    const converted = await prisma.companyInquiry.findUniqueOrThrow({ where: { id: row.id } });
    expect(converted.convertedCompanyId).not.toBeNull();
    expect(converted.status).toBe('CLOSED');
    const company = await prisma.company.findUniqueOrThrow({ where: { id: converted.convertedCompanyId! } });
    expect(company.orgId).toBe(orgId);
    expect(company.contactEmail).toBe(email);
    const relation = await prisma.mentorshipRelation.findFirstOrThrow({
      where: { companyId: company.id },
      include: { mentee: { select: { email: true, role: true, referralSource: true } } },
    });
    // The admin who pressed the button owns it (no default owner is set), at
    // the org's first stage, with a stand-in lead — never a login on their mailbox.
    expect(relation.mentorId).toBe(mktAdminId);
    expect(relation.pipelineStatus).toBe(firstStage);
    expect(relation.mentee.role).toBe('MENTEE');
    expect(relation.mentee.email).not.toBe(email);
    expect(relation.mentee.referralSource).toBe('linkedin');
    // No COMPANY login and no invitation: marketing sells to the company.
    expect(await prisma.invitationToken.count({ where: { email } })).toBe(0);

    // A second click is idempotent.
    const again = await mktPage.request.post(`/api/admin/company-inquiries/${row.id}/convert`, { data: {} });
    expect(again.status()).toBe(409);
    expect((await again.json()).code).toBe('already_converted');
    expect(await prisma.company.count({ where: { orgId, name: companyName } })).toBe(1);
    expect(await prisma.mentorshipRelation.count({ where: { companyId: company.id } })).toBe(1);
  } finally {
    await mktContext.close();
  }
});

test('with a default lead owner, a request lands on that rep’s funnel by itself — and so does a hand-typed lead', async ({ request, browser }) => {
  test.setTimeout(120_000);
  await prisma.setting.create({ data: { orgId, key: 'defaultLeadOwnerId', value: mktRepId } });

  const companyName = `Owned Handel ${stamp}`;
  const email = newInquiryEmail('demo-form-owned');
  const res = await postInquiry(request, MARKETING_HOST, {
    companyName,
    contactName: 'Otto Owned',
    email,
    marketplaces: 'eBay',
    marketingOptIn: true,
  });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).placed).toBe(true);

  const row = await prisma.companyInquiry.findFirstOrThrow({ where: { email } });
  expect(row.orgId).toBe(orgId);
  expect(row.marketingOptIn).toBe(true);
  expect(row.convertedCompanyId).not.toBeNull();
  const relation = await prisma.mentorshipRelation.findFirstOrThrow({ where: { companyId: row.convertedCompanyId! } });
  expect(relation.mentorId).toBe(mktRepId);
  expect(relation.pipelineStatus).toBe(firstStage);

  // The hand-typed lead (#2562) with no owner in the body goes to the same rep;
  // the admin typing it stays the actor.
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signInAndSettle(page, mktAdminEmail, PW, '/admin');
    const manual = await page.request.post('/api/admin/marketing-accounts', {
      data: { name: `Typed Handel ${stamp}`, contactName: 'Tia Typed', contactEmail: uniqueEmail('demo-form-typed') },
    });
    expect(manual.status()).toBe(201);
    const body = await manual.json();
    expect(body.ownerId).toBe(mktRepId);
    const typed = await prisma.mentorshipRelation.findFirstOrThrow({ where: { companyId: body.companyId } });
    expect(typed.mentorId).toBe(mktRepId);

    // An owner from another tenant is refused, both in the body and as the setting.
    const foreign = await page.request.post('/api/admin/marketing-accounts', {
      data: { name: `Foreign Handel ${stamp}`, contactEmail: uniqueEmail('demo-form-foreign'), ownerId: intAdminId },
    });
    expect(foreign.status()).toBe(400);
    expect((await foreign.json()).code).toBe('invalid_owner');
    const setting = await page.request.put('/api/admin/settings', { data: { defaultLeadOwnerId: intAdminId } });
    expect(setting.status()).toBe(400);
    const cleared = await page.request.put('/api/admin/settings', { data: { defaultLeadOwnerId: '' } });
    expect(cleared.ok()).toBeTruthy();
    expect((await cleared.json()).settings.defaultLeadOwnerId).toBe('');
  } finally {
    await context.close();
  }
});

test('an unmapped marketing host is a closed form — it never writes into the internship org', async ({ page, request }) => {
  await prisma.organization.update({ where: { id: orgId }, data: { publicHost: null } });
  const email = newInquiryEmail('demo-form-closed');

  await openMarketingLanding(page);
  await expect(page.getByTestId('landing-demo-unavailable')).toBeVisible();
  await expect(page.getByTestId('company-inquiry-form')).toHaveCount(0);

  const res = await postInquiry(request, MARKETING_HOST, { companyName: `Closed ${stamp}`, contactName: 'Nobody', email });
  expect(res.status()).toBe(503);
  expect((await res.json()).code).toBe('form_unavailable');
  expect(await prisma.companyInquiry.count({ where: { email } })).toBe(0);

  // The internship host is unaffected: it still writes to the default org.
  const intEmail = newInquiryEmail('demo-form-int');
  const intRes = await postInquiry(request, 'localhost', { companyName: `Intern Co ${stamp}`, contactName: 'Ina', email: intEmail, openRoles: 'Backend' });
  expect(intRes.ok()).toBeTruthy();
  const intRow = await prisma.companyInquiry.findFirstOrThrow({ where: { email: intEmail } });
  expect(intRow.orgId).not.toBe(orgId);
  expect(intRow.openRoles).toBe('Backend');
  expect(intRow.marketingOptIn).toBeNull();
  expect(intRow.consentTextVersion).toBe(PRIVACY_POLICY_VERSION);
});
