import { test, expect } from '@playwright/test';
import { createHmac } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { E2E_INBOUND_SECRET } from '../playwright.config';

// BCC-to-CRM (#2809, docs/marketing-vertical/sales-email-capture.md): a rep
// writes to a customer from their own mailbox with the org's `crm+…` address
// in BCC, and the CRM logs date + subject + recipients on the account.
//   1. org token + active staff sender + a known account address → one log,
//      metadata only; the same mail again → still one log;
//   2. a stranger, a forged token, an unknown recipient → nothing;
//   3. rotating the address kills the old one; switching it off stops it;
//   4. an INTERNSHIP org is off until it opts in.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const authed = { 'x-inbound-secret': E2E_INBOUND_SECRET };
const PW = 'CrmBcc12345';

// Mirror src/lib/crmBccTokens.ts so the test can mint addresses.
const secret = () => process.env.NEXTAUTH_SECRET || 'dev-secret';
const crmAddress = (orgId: string, version: string, sig?: string) => {
  const payload = `${orgId}~${version}`;
  const s = sig ?? createHmac('sha256', secret()).update(`crm-bcc:${payload}`).digest('hex').slice(0, 32);
  return `crm+${payload}.${s}@in.e2e.example`;
};

test('BCC-to-CRM logs a sent mail on the account, once, and only for the org’s staff', async ({ page, request }) => {
  test.setTimeout(150_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `BCC MKT ${stamp}`, slug: `bcc-mkt-${stamp}`, vertical: 'MARKETING' } });
  const intern = await prisma.organization.create({ data: { name: `BCC INT ${stamp}`, slug: `bcc-int-${stamp}`, vertical: 'INTERNSHIP' } });

  const adminEmail = uniqueEmail('bcc-admin');
  const repEmail = uniqueEmail('bcc-rep');
  const leadEmail = uniqueEmail('bcc-lead');
  const internAdminEmail = uniqueEmail('bcc-int-admin');
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Bcc Admin');
  const rep = await seedUser(repEmail, PW, 'MENTOR', 'Bcc Rep');
  const lead = await seedUser(leadEmail, PW, 'MENTEE', 'Bcc Lead');
  const internAdmin = await seedUser(internAdminEmail, PW, 'ADMIN', 'Bcc Int Admin');
  await prisma.user.updateMany({ where: { id: { in: [admin.id, rep.id, lead.id] } }, data: { orgId: org.id } });
  await prisma.user.update({ where: { id: internAdmin.id }, data: { orgId: intern.id } });

  const customer = `kunde-${stamp}@shop.example`;
  const boss = `chef-${stamp}@shop.example`;
  const company = await prisma.company.create({ data: { orgId: org.id, name: `Shop ${stamp}`, contactEmail: customer } });
  await prisma.companyContact.create({ data: { orgId: org.id, companyId: company.id, name: 'Chef', email: boss } });
  const rel = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: rep.id, menteeId: lead.id, companyId: company.id } });
  const logs = () => prisma.interactionLog.findMany({ where: { relationId: rel.id } });
  const send = (data: Record<string, string>) => request.post('/api/inbound-email', { headers: authed, data });

  try {
    // 1. A rep's mail to the account, its manager in Cc.
    const mail = {
      to: `Kunde <${customer}>, ${crmAddress(org.id, '1')}`,
      cc: `Chef <${boss}>`,
      from: `Bcc Rep <${repEmail}>`,
      subject: 'Angebot   Q4\n2026',
      date: 'Mon, 05 Oct 2026 09:00:00 +0200',
      text: 'SECRET BODY that must never be stored',
      messageId: `<bcc-1-${stamp}@vendor.example>`,
    };
    const ok = await send(mail);
    expect(ok.status(), await ok.text()).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, logged: 1, duplicates: 0 });
    const [log] = await logs();
    expect(log).toMatchObject({ type: 'Email', autoLogged: true, subject: 'Angebot Q4 2026' });
    expect(log.date.toISOString()).toBe('2026-10-05T07:00:00.000Z');
    expect(log.notes).toContain(customer);
    expect(log.notes).toContain(boss);
    expect(log.notes).not.toContain('SECRET');
    expect(log.sourceRef).toMatch(/^bcc:[0-9a-f]{40}$/);

    // The same mail delivered again is still one log.
    const again = await send(mail);
    expect(await again.json()).toMatchObject({ logged: 0, duplicates: 1 });
    expect(await logs()).toHaveLength(1);

    // 2. A stranger with the right address, a forged address, an unknown recipient.
    expect((await send({ ...mail, from: 'someone@else.example', messageId: `<s-${stamp}@x>` })).status()).toBe(403);
    expect((await send({ ...mail, from: `Bcc Lead <${leadEmail}>`, messageId: `<l-${stamp}@x>` })).status()).toBe(403);
    expect((await send({ ...mail, to: crmAddress(org.id, '1', 'deadbeef'.repeat(4)), messageId: `<f-${stamp}@x>` })).status()).toBe(400);
    const unmatched = await send({ ...mail, to: `other@nowhere.example, ${crmAddress(org.id, '1')}`, cc: '', messageId: `<u-${stamp}@x>` });
    expect(await unmatched.json()).toMatchObject({ ok: true, logged: 0 });
    expect(await logs()).toHaveLength(1);
    expect(await prisma.contactPermission.count({ where: { orgId: org.id } })).toBe(0);

    // 3. The admin sees the card, rotates the address, then switches it off.
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, adminEmail, PW, '/admin');
    await gotoSettled(page, '/admin/settings');
    await expect(page.getByTestId('crm-bcc-card')).toBeVisible({ timeout: 20_000 });
    const state = await (await page.request.get('/api/admin/crm-bcc')).json();
    expect(state).toMatchObject({ enabled: true, explicit: false });

    const rotated = await page.request.post('/api/admin/crm-bcc', { data: { action: 'rotate' } });
    expect(rotated.status()).toBe(200);
    expect((await prisma.setting.findFirst({ where: { orgId: org.id, key: 'crmBccVersion' } }))?.value).toBe('2');
    expect((await send({ ...mail, messageId: `<old-${stamp}@x>` })).status()).toBe(403);
    const fresh = await send({ ...mail, to: `${customer}, ${crmAddress(org.id, '2')}`, messageId: `<new-${stamp}@x>` });
    expect(await fresh.json()).toMatchObject({ logged: 1 });

    expect((await page.request.post('/api/admin/crm-bcc', { data: { action: 'disable' } })).status()).toBe(200);
    expect((await send({ ...mail, to: `${customer}, ${crmAddress(org.id, '2')}`, messageId: `<off-${stamp}@x>` })).status()).toBe(403);
    expect(await logs()).toHaveLength(2);
    expect((await page.request.post('/api/admin/crm-bcc', { data: { action: 'bogus' } })).status()).toBe(400);

    // 4. INTERNSHIP: off by default, on once the org opts in.
    const internMail = { to: `x@y.example, ${crmAddress(intern.id, '1')}`, from: internAdminEmail, messageId: `<i-${stamp}@x>` };
    expect((await send(internMail)).status()).toBe(403);
    await prisma.setting.create({ data: { orgId: intern.id, key: 'crmBccEnabled', value: 'true' } });
    expect((await send(internMail)).status()).toBe(200);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { companyId: company.id } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: company.id } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { targetId: { in: [org.id, intern.id] } } }).catch(() => {});
    for (const e of [adminEmail, repEmail, leadEmail, internAdminEmail]) await cleanupByEmail(e);
    await prisma.setting.deleteMany({ where: { orgId: { in: [org.id, intern.id] } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, intern.id] } } }).catch(() => {});
  }
});
