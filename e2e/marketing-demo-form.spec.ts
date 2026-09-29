import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { MARKETING_OPT_IN_TEXT_VERSION, PRIVACY_POLICY_VERSION } from '../src/lib/privacy';
import { doiMailCapKey, makeContactPermissionToken } from '../src/lib/contactPermissionTokens';
import { __testable as emailInternals } from '@/services/emailService';

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
// Serial: `publicHost` is unique, and test 4 needs the host UNmapped. The host
// is a real one, so whatever org held it before this spec (an operator's
// set-public-host.mjs run on a reused DB) gets it back in afterAll — a test run
// must never silently close a form somebody opened.

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
let previousHolderId: string | null = null;
const inquiryEmails: string[] = [];

test.beforeAll(async () => {
  // Borrow the host from whoever holds it (restored in afterAll). A leftover
  // from a crashed run of THIS spec is recognisable by its slug and is not
  // worth restoring.
  const holder = await prisma.organization.findUnique({ where: { publicHost: MARKETING_HOST }, select: { id: true, slug: true } });
  if (holder && !holder.slug.startsWith('demo-form-mkt-')) previousHolderId = holder.id;
  if (holder) await prisma.organization.update({ where: { id: holder.id }, data: { publicHost: null } });
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
  await prisma.source.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  // Give the host back only once the test org (and its claim) is gone.
  if (previousHolderId) {
    await prisma.organization
      .update({ where: { id: previousHolderId }, data: { publicHost: MARKETING_HOST } })
      .catch((e) => console.error(`marketing-demo-form: could not restore publicHost ${MARKETING_HOST}:`, e));
  }
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
  expect(row.marketingOptInRequested).toBe(false);
  expect(row.marketingOptInTextVersion).toBeNull();
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
    await mktPage.context().setExtraHTTPHeaders({ 'x-forwarded-host': MARKETING_HOST }); // MARKETING-org admin => marketing host (#2590)
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
      include: {
        mentee: { select: { email: true, role: true, referralSource: true, source: { select: { name: true, orgId: true } } } },
      },
    });
    // The admin who pressed the button owns it (no default owner is set), at
    // the org's first stage, with a stand-in lead — never a login on their mailbox.
    expect(relation.mentorId).toBe(mktAdminId);
    expect(relation.pipelineStatus).toBe(firstStage);
    expect(relation.mentee.role).toBe('MENTEE');
    expect(relation.mentee.email).not.toBe(email);
    expect(relation.mentee.referralSource).toBe('linkedin');
    // …and it is ATTRIBUTED (#2570): bound to this org's Source by the one
    // mapping rule, utm:<source>/<medium>/<campaign>.
    expect(relation.mentee.source).toEqual({ name: 'utm:linkedin/social/autumn-2026', orgId });
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
  // The public answer never says whether it was placed — that would tell an
  // anonymous caller whether the address is a staff member's or a lead's.
  expect(await res.json()).toEqual({ ok: true });

  const row = await prisma.companyInquiry.findFirstOrThrow({ where: { email } });
  expect(row.orgId).toBe(orgId);
  // A request, stamped with its own wording version — never a confirmed opt-in.
  expect(row.marketingOptInRequested).toBe(true);
  expect(row.marketingOptInTextVersion).toBe(MARKETING_OPT_IN_TEXT_VERSION);
  expect(row.marketingOptInConfirmedAt).toBeNull();
  expect(row.convertedCompanyId).not.toBeNull();
  const relation = await prisma.mentorshipRelation.findFirstOrThrow({
    where: { companyId: row.convertedCompanyId! },
    include: { mentee: { select: { sourceId: true } } },
  });
  expect(relation.mentorId).toBe(mktRepId);
  expect(relation.pipelineStatus).toBe(firstStage);
  // No utm_source ⇒ unknown channel ⇒ NO Source row: the lead is counted in the
  // report's explicit `unsourced` bucket instead (#2570).
  expect(relation.mentee.sourceId).toBeNull();

  // The hand-typed lead (#2562) with no owner in the body goes to the same rep;
  // the admin typing it stays the actor.
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.context().setExtraHTTPHeaders({ 'x-forwarded-host': MARKETING_HOST }); // MARKETING-org admin => marketing host (#2590)
    await signInAndSettle(page, mktAdminEmail, PW, '/admin');
    const manual = await page.request.post('/api/admin/marketing-accounts', {
      data: {
        name: `Typed Handel ${stamp}`,
        contactName: 'Tia Typed',
        contactEmail: uniqueEmail('demo-form-typed'),
        source: `Messe ${stamp}`,
      },
    });
    expect(manual.status()).toBe(201);
    const body = await manual.json();
    expect(body.ownerId).toBe(mktRepId);
    const typed = await prisma.mentorshipRelation.findFirstOrThrow({
      where: { companyId: body.companyId },
      include: { mentee: { select: { referralSource: true, source: { select: { name: true, orgId: true } } } } },
    });
    expect(typed.mentorId).toBe(mktRepId);
    // A typed source is the Source a person named (#2570): kept as written,
    // bound to (and created in) THIS org.
    expect(typed.mentee.referralSource).toBe(`Messe ${stamp}`);
    expect(typed.mentee.source).toEqual({ name: `Messe ${stamp}`, orgId });

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

// The double opt-in and the account's contact permission (#2577). Runs after
// the default-owner test, so the request lands on the rep's funnel by itself
// and the account exists before the click — the path where the click has to
// reach an existing account. (The other path — confirm first, convert later —
// is `applyInquiryPermission` at conversion.)
test('a ticked box mails ONE confirmation a day; the click makes the account DOI_CONFIRMED and the link takes it back', async ({ request, page, browser }) => {
  test.setTimeout(150_000);
  await prisma.setting.updateMany({ where: { orgId, key: 'defaultLeadOwnerId' }, data: { value: mktRepId } });
  const companyName = `Opt In Handel ${stamp}`;
  const email = newInquiryEmail('demo-form-doi');
  const confirmMails = () => prisma.emailLog.count({ where: { to: email, category: 'consent' } });

  const res = await postInquiry(request, MARKETING_HOST, {
    companyName,
    contactName: 'Dora Double',
    email,
    marketingOptIn: true,
    locale: 'de',
  });
  expect(res.ok()).toBeTruthy();
  // Same body whether or not a mail went out.
  expect(await res.json()).toEqual({ ok: true });
  const first = await prisma.companyInquiry.findFirstOrThrow({ where: { email, companyName } });
  expect(first.marketingOptInConfirmedAt).toBeNull();
  // SMTP is blank under e2e, so the mail is attempted (one SKIPPED consent
  // row) but not SENT — and a mail that was not sent neither stamps the
  // evidence column nor spends the address's daily slot.
  expect(await confirmMails()).toBe(1);
  expect(first.marketingOptInMailSentAt).toBeNull();
  const capKey = doiMailCapKey(email, new Date());
  expect(await prisma.contactConfirmationMailCap.count({ where: { key: capKey } })).toBe(0);

  // Converted by the default owner: the account exists and may be ANSWERED,
  // which is not advertising permission.
  expect(first.convertedCompanyId).not.toBeNull();
  const companyId = first.convertedCompanyId!;
  const beforeClick = await prisma.contactPermission.findUniqueOrThrow({
    where: { companyId_channel: { companyId, channel: 'EMAIL' } },
  });
  expect(beforeClick.basis).toBe('INQUIRY_REPLY');
  expect(beforeClick.orgId).toBe(orgId);

  // A second request for the same address the same day sends no second mail
  // once the day's slot IS spent (as a SENT mail would have spent it).
  await prisma.contactConfirmationMailCap.create({ data: { key: capKey } });
  const again = await postInquiry(request, MARKETING_HOST, {
    companyName: `${companyName} Zwei`,
    contactName: 'Dora Double',
    email,
    marketingOptIn: true,
  });
  expect(again.ok()).toBeTruthy();
  const second = await prisma.companyInquiry.findFirstOrThrow({ where: { email, companyName: `${companyName} Zwei` } });
  expect(second.marketingOptInRequested).toBe(true);
  expect(second.marketingOptInMailSentAt).toBeNull();
  expect(await confirmMails()).toBe(1);

  // The address owner opens the link and presses the button (the page POSTs;
  // opening the link alone confirms nothing).
  const confirmToken = makeContactPermissionToken('confirm', first.id);
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': MARKETING_HOST, 'x-forwarded-for': clientIp() });
  await page.goto(`/contact-permission/confirm?token=${encodeURIComponent(confirmToken)}`);
  expect((await prisma.companyInquiry.findUniqueOrThrow({ where: { id: first.id } })).marketingOptInConfirmedAt).toBeNull();
  await page.getByTestId('contact-permission-button').click();
  await expect(page.getByTestId('contact-permission-done')).toBeVisible({ timeout: 15_000 });

  const confirmed = await prisma.companyInquiry.findUniqueOrThrow({ where: { id: first.id } });
  expect(confirmed.marketingOptInConfirmedAt).not.toBeNull();
  const permission = await prisma.contactPermission.findUniqueOrThrow({
    where: { companyId_channel: { companyId, channel: 'EMAIL' } },
  });
  expect(permission.basis).toBe('DOI_CONFIRMED');
  expect(permission.source).toBe('DOI_LINK');
  expect(permission.confirmedAt).not.toBeNull();
  expect(permission.textVersion).toBe(MARKETING_OPT_IN_TEXT_VERSION);
  expect(permission.textLocale).toBe('de');
  expect(permission.address).toBe(email.toLowerCase());
  expect(permission.revokedAt).toBeNull();

  const context = await browser.newContext();
  const admin = await context.newPage();
  try {
    await signInAndSettle(admin, mktAdminEmail, PW, '/admin');
    const listed = async () => {
      const r = await admin.request.get(`/api/companies?permission=email&search=${encodeURIComponent(companyName)}`);
      expect(r.ok()).toBeTruthy();
      return ((await r.json()).companies as { id: string }[]).map((c) => c.id);
    };
    expect(await listed()).toContain(companyId);
    // The list filter on screen, and its badge.
    await gotoSettled(admin, '/admin/companies');
    await admin.getByTestId('companies-permission-filter').selectOption('email');
    await admin.getByTestId('companies-search').fill(companyName);
    await expect(admin.getByTestId(`company-email-permission-${companyId}`)).toBeVisible({ timeout: 15_000 });
    // …and the owning rep's own account list.
    const repContext = await browser.newContext();
    try {
      const rep = await repContext.newPage();
      await signInAndSettle(rep, mktRepEmail, PW, '/sales');
      await gotoSettled(rep, '/sales/accounts?permission=email');
      await expect(rep.getByTestId(`sales-account-permission-${companyId}`)).toHaveText('Yes');
    } finally {
      await repContext.close();
    }
    await gotoSettled(admin, `/admin/companies/${companyId}`);
    await expect(admin.getByTestId('company-detail-permission-basis-EMAIL')).toHaveAttribute('data-basis', 'DOI_CONFIRMED');
    await expect(admin.getByTestId('company-detail-email-permission')).toHaveAttribute('data-permitted', 'true');

    // An admin cannot type a double opt-in in, nor a §7(3) record without its reason.
    const forged = await admin.request.put(`/api/admin/companies/${companyId}/contact-permission`, {
      data: { action: 'set', channel: 'EMAIL', basis: 'DOI_CONFIRMED' },
    });
    expect(forged.status()).toBe(400);
    const bare = await admin.request.put(`/api/admin/companies/${companyId}/contact-permission`, {
      data: { action: 'set', channel: 'EMAIL', basis: 'EXISTING_CUSTOMER_7_3' },
    });
    expect((await bare.json()).code).toBe('reason_required');

    // The opt-out link takes it back — and a confirmation after it is refused.
    const optOut = await request.post('/api/contact-permission/opt-out', {
      headers: { 'x-forwarded-for': clientIp() },
      data: { token: makeContactPermissionToken('optout', first.id) },
    });
    expect(optOut.ok()).toBeTruthy();
    const revoked = await prisma.contactPermission.findUniqueOrThrow({
      where: { companyId_channel: { companyId, channel: 'EMAIL' } },
    });
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedVia).toBe('LINK');
    expect(revoked.basis).toBe('DOI_CONFIRMED');
    expect(await listed()).not.toContain(companyId);
    const reconfirm = await request.post('/api/contact-permission/confirm', {
      headers: { 'x-forwarded-for': clientIp() },
      data: { token: confirmToken },
    });
    expect(reconfirm.status()).toBe(409);
    // A confirm token is not an opt-out token, and the reverse.
    const crossed = await request.post('/api/contact-permission/confirm', {
      headers: { 'x-forwarded-for': clientIp() },
      data: { token: makeContactPermissionToken('optout', first.id) },
    });
    expect(crossed.status()).toBe(400);
    // Nobody here re-grants what the person withdrew.
    const regrant = await admin.request.put(`/api/admin/companies/${companyId}/contact-permission`, {
      data: { action: 'set', channel: 'EMAIL', basis: 'EXISTING_CUSTOMER_7_3', reason: 'Paid invoice 2026-0042 in March' },
    });
    expect(regrant.status()).toBe(400);
    expect((await regrant.json()).code).toBe('owner_objected');
    // …not in two steps either: a neutral basis would clear the objection and
    // let § 7(3) through on the next request, so the row is locked to it too.
    for (const basis of ['NONE', 'INQUIRY_REPLY'] as const) {
      const neutral = await admin.request.put(`/api/admin/companies/${companyId}/contact-permission`, {
        data: { action: 'set', channel: 'EMAIL', basis },
      });
      expect(neutral.status()).toBe(400);
      expect((await neutral.json()).code).toBe('owner_objected');
    }
    const stillLocked = await prisma.contactPermission.findUniqueOrThrow({
      where: { companyId_channel: { companyId, channel: 'EMAIL' } },
    });
    expect(stillLocked.revokedVia).toBe('LINK');
    expect(stillLocked.revokedAt).not.toBeNull();

    // Another request's account: confirmed, then revoked by an admin (the
    // person objected by phone). Replaying the old confirm link is not a new
    // consent and must not revive it; the person's own opt-out afterwards
    // still records itself, and locks the row.
    const replayEmail = newInquiryEmail('demo-form-doi-replay');
    const replayName = `Opt In Replay ${stamp}`;
    const placed = await postInquiry(request, MARKETING_HOST, {
      companyName: replayName,
      contactName: 'Rita Replay',
      email: replayEmail,
      marketingOptIn: true,
      locale: 'de',
    });
    expect(placed.ok()).toBeTruthy();
    const third = await prisma.companyInquiry.findFirstOrThrow({ where: { email: replayEmail, companyName: replayName } });
    const secondCompanyId = third.convertedCompanyId;
    expect(secondCompanyId).not.toBeNull();
    expect(secondCompanyId).not.toBe(companyId);
    const secondToken = makeContactPermissionToken('confirm', third.id);
    const confirmSecond = await request.post('/api/contact-permission/confirm', {
      headers: { 'x-forwarded-for': clientIp() },
      data: { token: secondToken },
    });
    expect(confirmSecond.ok()).toBeTruthy();
    const secondKey = { companyId_channel: { companyId: secondCompanyId!, channel: 'EMAIL' as const } };
    expect((await prisma.contactPermission.findUniqueOrThrow({ where: secondKey })).basis).toBe('DOI_CONFIRMED');
    const adminRevoke = await admin.request.put(`/api/admin/companies/${secondCompanyId}/contact-permission`, {
      data: { action: 'revoke', channel: 'EMAIL' },
    });
    expect(adminRevoke.ok()).toBeTruthy();
    const replay = await request.post('/api/contact-permission/confirm', {
      headers: { 'x-forwarded-for': clientIp() },
      data: { token: secondToken },
    });
    expect(replay.ok()).toBeTruthy();
    const afterReplay = await prisma.contactPermission.findUniqueOrThrow({ where: secondKey });
    expect(afterReplay.revokedAt).not.toBeNull();
    expect(afterReplay.revokedVia).toBe('ADMIN');
    const optOutSecond = await request.post('/api/contact-permission/opt-out', {
      headers: { 'x-forwarded-for': clientIp() },
      data: { token: makeContactPermissionToken('optout', third.id) },
    });
    expect(optOutSecond.ok()).toBeTruthy();
    const afterOptOut = await prisma.contactPermission.findUniqueOrThrow({ where: secondKey });
    expect(afterOptOut.revokedVia).toBe('LINK');
    expect(afterOptOut.revokedAt!.getTime()).toBe(afterReplay.revokedAt!.getTime());
    const overObjection = await admin.request.put(`/api/admin/companies/${secondCompanyId}/contact-permission`, {
      data: { action: 'set', channel: 'EMAIL', basis: 'EXISTING_CUSTOMER_7_3', reason: 'Paid invoice 2026-0043 in April' },
    });
    expect(overObjection.status()).toBe(400);
    expect((await overObjection.json()).code).toBe('owner_objected');
    await gotoSettled(admin, `/admin/companies/${companyId}`);
    await expect(admin.getByTestId('company-detail-permission-basis-EMAIL')).toHaveAttribute('data-revoked', 'true');
    await expect(admin.getByTestId('company-detail-email-permission')).toHaveAttribute('data-permitted', 'false');
  } finally {
    await context.close();
  }
});

// @smoke: the fail-closed rule is the cross-tenant guard (a stranger's request
// must never land in another company's inbox), and it is cheap.
// #2495: an invitation is read later, somewhere else, so its link cannot follow
// a request — it follows the invited tenant's own host mapping. Before, every
// register link was built from NEXT_PUBLIC_APP_URL and a SaleVali admin's
// invitation opened the internship product. Here the mapped host is served
// (MARKETING_HOSTS' default), so the MARKETING admin's link lands on it; the
// internship admin's, whose org maps nothing, is exactly what it always was.
test('an invitation link opens the invited tenant’s own product host', async ({ browser }) => {
  const invitees: string[] = [];
  const mkt = await browser.newContext();
  const int = await browser.newContext();
  try {
    const mktPage = await mkt.newPage();
    await mktPage.context().setExtraHTTPHeaders({ 'x-forwarded-host': MARKETING_HOST }); // MARKETING-org admin => marketing host (#2590)
    await signInAndSettle(mktPage, mktAdminEmail, PW, '/admin');
    const intPage = await int.newPage();
    await signInAndSettle(intPage, intAdminEmail, PW, '/admin');

    const inviteHost = async (page: Page) => {
      const email = uniqueEmail('mkt-link-invitee');
      invitees.push(email);
      const res = await page.request.post('/api/invite', { data: { email, role: 'MENTOR' } });
      expect(res.ok(), await res.text()).toBeTruthy();
      const { registerUrl } = (await res.json()) as { registerUrl: string };
      const url = new URL(registerUrl);
      expect(url.pathname).toBe('/auth/register');
      expect(url.searchParams.get('token')).toBeTruthy();
      return url.host;
    };

    expect(await inviteHost(mktPage)).toBe(MARKETING_HOST);
    // The default org maps no host: the configured origin, unchanged.
    expect(await inviteHost(intPage)).toBe(new URL(test.info().project.use.baseURL ?? 'http://localhost:3000').host);
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email: { in: invitees } } }).catch(() => {});
    await prisma.emailLog.deleteMany({ where: { to: { in: invitees } } }).catch(() => {});
    await mkt.close();
    await int.close();
  }
});

test('a gated mail that passes only userId gets its footer and List-Unsubscribe on the recipient tenant host (#2495)', async () => {
  // sendEmail()'s IMPLICIT origin path — the caller passes a userId and no
  // orgId, which is what most gated mails do — resolved through
  // the account's org (appUrlForUser). SMTP is blanked under Playwright, so the send itself
  // short-circuits; optOutParts() is the exact step sendEmail() runs for the
  // footer. It lives in this serial spec because it needs MARKETING_HOST mapped.
  process.env.NEXTAUTH_SECRET ||= 'unit-test-secret';
  const hostsOf = async (userId: string) => {
    const { body, headers } = await emailInternals.optOutParts('<p>hi</p>', userId, 'digests');
    const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1]).host);
    const one = /<([^>]+)>/.exec(headers['List-Unsubscribe'])![1];
    return { hrefs, one: new URL(one).host };
  };

  const mkt = await hostsOf(mktRepId);
  expect(mkt.hrefs.length, 'the footer carries links').toBeGreaterThan(0);
  for (const h of mkt.hrefs) expect(h, 'marketing footer link').toBe(MARKETING_HOST);
  expect(mkt.one, 'marketing List-Unsubscribe').toBe(MARKETING_HOST);

  // The default (internship) org maps no host: the configured origin, unchanged.
  const int = await hostsOf(intAdminId);
  for (const h of int.hrefs) expect(h, 'internship footer link').not.toBe(MARKETING_HOST);
  expect(int.one, 'internship List-Unsubscribe').not.toBe(MARKETING_HOST);
  // An origin sendEmail() already resolved (from `orgId`) still wins over the lookup.
  const pinned = await emailInternals.optOutParts('<p>hi</p>', mktRepId, 'digests', null, 'https://pinned.example');
  expect(new URL(/<([^>]+)>/.exec(pinned.headers['List-Unsubscribe'])![1]).host).toBe('pinned.example');
});

test('an unmapped marketing host is a closed form — it never writes into the internship org', { tag: '@smoke' }, async ({ page, request }) => {
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
  expect(intRow.marketingOptInRequested).toBeNull();
  expect(intRow.consentTextVersion).toBe(PRIVACY_POLICY_VERSION);
});
