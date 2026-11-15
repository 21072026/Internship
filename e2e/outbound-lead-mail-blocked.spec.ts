import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { recipientHash } from '@/lib/mailDeliveryRule';
import { applyDraftAction, type OutboxActor } from '@/lib/outboundDrafts';
import { sendDoiConfirmation } from '@/lib/contactPermissionDoi';
import {
  mailMeterIdleForTests,
  resetMailTransportsForTests,
  sendContactPermissionConfirmationEmail,
  sendEmail,
  sendPasswordResetEmail,
  sendTrialReminderEmail,
} from '@/services/emailService';
import { startFakeSmtp, type FakeSmtp } from './helpers/fakeSmtp';
import { drainNotificationMail } from './helpers/notificationMail';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { asHost, gotoSettled, MARKETING_HOST, signInAndSettle, signInViaApi } from './helpers/auth';

// Lead mail switched off entirely (#3771, docs/outbound-approval.md): with
// `outboundApproval = 'lead_mail_blocked'` NO mail of a MARKETING org reaches a
// lead, a customer or a contact — no exemption, a password reset and the
// double opt-in included — no mail, no draft, no job, one EmailLog row
// SKIPPED; the org's own staff keep theirs.
//
// Same harness as outbound-approval.spec.ts: the app server Playwright boots
// has no SMTP, so this process points ITSELF at a fake SMTP server and calls
// the functions the crons and routes call. Local database only.
const local = !process.env.BASE_URL;
const PASSWORD = 'BlockedPass123!';
const STAMP = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

const E = {
  admin: uniqueEmail(`olb-admin-${STAMP}`),
  rep: uniqueEmail(`olb-rep-${STAMP}`),
  lead: uniqueEmail(`olb-lead-${STAMP}`),
  customer: uniqueEmail(`olb-customer-${STAMP}`),
  internLead: uniqueEmail(`olb-intern-${STAMP}`),
};
const CONTACT = `olb-contact-${STAMP}@acme-sales.example.test`;

const ids: Record<string, string> = {};
const orgIds: string[] = [];
let smtp: FakeSmtp;
const saved: Record<string, string | undefined> = {};
const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'MAIL_INLINE_TIMEOUT_MS', 'MAIL_METER_MODE', 'MAIL_QUEUE_LANES'];
const H = asHost(MARKETING_HOST);

const draftsFor = (address: string) => prisma.outboundDraft.findMany({ where: { rcpt: recipientHash(address) } });
async function jobsFor(address: string) {
  const rcpt = recipientHash(address);
  const rows = await prisma.job.findMany({ where: { name: 'email.send' } });
  return rows.filter((r) => (r.payload as { rcpt?: string } | null)?.rcpt === rcpt);
}
const logFor = (address: string) => prisma.emailLog.findMany({ where: { to: address }, orderBy: { createdAt: 'asc' } });

async function setMode(orgId: string, value: string) {
  await prisma.setting.deleteMany({ where: { orgId, key: 'outboundApproval', programId: null } });
  await prisma.setting.create({ data: { orgId, key: 'outboundApproval', value } });
}

test.describe('outbound approval: lead mail blocked', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!local, 'sends mail from this process against the local database and a fake SMTP server');

  test.beforeAll(async () => {
    smtp = await startFakeSmtp();
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_USER = 'blocked-e2e';
    process.env.SMTP_PASS = 'blocked-e2e';
    process.env.SMTP_FROM = 'noreply@example.test';
    process.env.NEXTAUTH_SECRET ||= 'e2e-blocked-secret';
    delete process.env.MAIL_METER_MODE;
    delete process.env.MAIL_INLINE_TIMEOUT_MS;
    delete process.env.MAIL_QUEUE_LANES;
    resetMailTransportsForTests();

    const o = await prisma.organization.create({ data: { name: `Acme Sales Blocked ${STAMP}`, slug: `olb-${STAMP}`, vertical: 'MARKETING' } });
    ids.org = o.id;
    orgIds.push(o.id);
    await setMode(o.id, 'lead_mail_blocked');
    const intern = await prisma.organization.create({ data: { name: `Intern Blocked ${STAMP}`, slug: `olb-intern-${STAMP}`, vertical: 'INTERNSHIP' } });
    ids.intern = intern.id;
    orgIds.push(intern.id);
    // A row the API would refuse here: the rule must still read it as off.
    await setMode(intern.id, 'lead_mail_blocked');

    ids.admin = (await seedUser(E.admin, PASSWORD, 'ADMIN', `Blocked Admin ${STAMP}`, ids.org)).id;
    ids.rep = (await seedUser(E.rep, PASSWORD, 'MENTOR', `Blocked Rep ${STAMP}`, ids.org)).id;
    ids.lead = (await seedUser(E.lead, PASSWORD, 'MENTEE', `Blocked Lead ${STAMP}`, ids.org)).id;
    ids.customer = (await seedUser(E.customer, PASSWORD, 'COMPANY', `Blocked Customer ${STAMP}`, ids.org)).id;
    ids.internLead = (await seedUser(E.internLead, PASSWORD, 'MENTEE', `Intern Person ${STAMP}`, ids.intern)).id;
    await prisma.mentorshipRelation.create({ data: { orgId: ids.org, mentorId: ids.rep, menteeId: ids.lead } });
  });

  test.afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetMailTransportsForTests();
    await mailMeterIdleForTests().catch(() => {});
    for (const address of [...Object.values(E), CONTACT]) {
      for (const j of await jobsFor(address).catch(() => [])) await prisma.job.delete({ where: { id: j.id } }).catch(() => {});
      await prisma.emailLog.deleteMany({ where: { to: address } }).catch(() => {});
    }
    await prisma.outboundDraft.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
    for (const email of Object.values(E)) await cleanupByEmail(email);
    await prisma.setting.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
    await smtp?.close();
  });

  test('the same trial reminder reaches the rep and never the lead — no draft, no job, logged SKIPPED', { tag: '@smoke' }, async () => {
    const reminder = {
      fullName: 'Blocked Lead',
      companyName: 'Acme Sales',
      trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      threshold: 3,
      link: '/sales',
      orgId: ids.org,
    };
    await sendTrialReminderEmail({ ...reminder, userId: ids.lead });
    await sendTrialReminderEmail({ ...reminder, userId: ids.rep });
    // Routed through notifyEvent (#1711): run the notification.email jobs here.
    await drainNotificationMail([ids.lead, ids.rep]);

    expect(smtp.to(E.rep)).toHaveLength(1);
    expect(smtp.to(E.lead)).toHaveLength(0);
    expect(await draftsFor(E.lead)).toHaveLength(0);
    expect(await jobsFor(E.lead)).toHaveLength(0);
    const log = await logFor(E.lead);
    expect(log.map((l) => l.status)).toEqual(['SKIPPED']);
    expect(log[0].error).toBe('Blocked: outbound_blocked (blocked_lead)');
  });

  test('a customer, a contact and an unknown category are blocked too; sendEmail reports BLOCKED, and again tomorrow no draft', async () => {
    const toCustomer = await sendEmail({ to: E.customer, subject: `Win back ${STAMP}`, html: '<p>c</p>', category: 're-engagement', userId: ids.customer });
    expect(toCustomer).toBe('BLOCKED');
    const unknown = await sendEmail({ to: CONTACT, subject: `Unknown ${STAMP}`, html: '<p>?</p>', category: 'never-classified', orgId: ids.org });
    expect(unknown).toBe('BLOCKED');
    const again = await sendEmail({ to: CONTACT, subject: `Unknown ${STAMP}`, html: '<p>?</p>', category: 'never-classified', orgId: ids.org });
    expect(again).toBe('BLOCKED');
    expect(smtp.to(E.customer)).toHaveLength(0);
    expect(smtp.to(CONTACT)).toHaveLength(0);
    expect(await draftsFor(E.customer)).toHaveLength(0);
    expect(await draftsFor(CONTACT)).toHaveLength(0);
    expect((await logFor(E.customer)).map((l) => l.error)).toEqual(['Blocked: outbound_blocked (blocked_customer)']);
    expect((await logFor(CONTACT)).every((l) => l.status === 'SKIPPED' && l.error === 'Blocked: outbound_blocked (blocked_contact)')).toBe(true);
  });

  test('no exemption for a lead: a password reset and the double opt-in are blocked too; staff still gets a reset', async () => {
    const reset = await sendPasswordResetEmail({ to: E.lead, token: `tok-${STAMP}`, fullName: 'Blocked Lead', orgId: ids.org });
    expect(reset).toBe('BLOCKED');
    const doi = await sendContactPermissionConfirmationEmail({
      to: E.lead,
      contactName: 'Blocked Lead',
      companyName: 'Acme Sales',
      confirmUrl: 'https://acme-sales.example.test/confirm',
      optOutUrl: 'https://acme-sales.example.test/optout',
      orgId: ids.org,
    });
    expect(doi).toBe('BLOCKED');
    expect(smtp.to(E.lead)).toHaveLength(0);
    expect(await draftsFor(E.lead)).toHaveLength(0);
    const staffReset = await sendPasswordResetEmail({ to: E.rep, token: `tok-rep-${STAMP}`, fullName: 'Blocked Rep', orgId: ids.org });
    expect(staffReset).toBe('SENT');
    expect(smtp.to(E.rep).length).toBeGreaterThan(0);
  });

  test('the demo form\'s double opt-in, blocked: no mail, no evidence stamp, the slot is given back, no error', async () => {
    const inquiry = await prisma.companyInquiry.create({
      data: { orgId: ids.org, companyName: 'Acme Prospect', contactName: 'Pat Prospect', email: CONTACT, marketingOptInRequested: true },
    });
    try {
      const input = { inquiryId: inquiry.id, orgId: ids.org, email: CONTACT, contactName: 'Pat Prospect', companyName: 'Acme Prospect', locale: 'en', origin: 'https://acme-sales.example.test' };
      expect(await sendDoiConfirmation(input)).toBe('failed');
      // Not spent: a second submission the same day is not "capped" either.
      expect(await sendDoiConfirmation(input)).toBe('failed');
      const row = await prisma.companyInquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
      expect(row.marketingOptInMailSentAt).toBeNull();
      expect(row.marketingOptInConfirmedAt).toBeNull();
      expect(smtp.to(CONTACT)).toHaveLength(0);
      expect(await prisma.contactPermission.count({ where: { orgId: ids.org, basis: 'DOI_CONFIRMED' } })).toBe(0);
    } finally {
      await prisma.companyInquiry.deleteMany({ where: { id: inquiry.id } });
    }
  });

  test('INTERNSHIP never blocks, whatever a row says', async () => {
    const res = await sendEmail({ to: E.internLead, subject: `Intern ${STAMP}`, html: '<p>i</p>', category: 'dormant-check-in', userId: ids.internLead });
    expect(res).toBe('SENT');
    expect(smtp.to(E.internLead)).toHaveLength(1);
  });

  test('a draft held before the switch cannot leave once lead mail is blocked; it can be discarded', async () => {
    await setMode(ids.org, 'lead_mail');
    const held = await sendEmail({ to: E.lead, subject: `Held ${STAMP}`, html: '<p>h</p>', category: 'dormant-check-in', userId: ids.lead });
    expect(held).toBe('HELD');
    const [draft] = (await draftsFor(E.lead)).filter((d) => d.status === 'DRAFT');
    await setMode(ids.org, 'lead_mail_blocked');
    const actor: OutboxActor = { id: ids.admin, role: 'ADMIN', orgId: ids.org, email: E.admin };
    const send = await applyDraftAction(actor, draft.id, 'send');
    expect(send).toMatchObject({ ok: false, httpStatus: 409, code: 'outbound_blocked' });
    expect(smtp.to(E.lead).filter((m) => m.data.includes(`Held ${STAMP}`))).toHaveLength(0);
    const discard = await applyDraftAction(actor, draft.id, 'discard');
    expect(discard).toMatchObject({ ok: true, status: 'DISCARDED' });
  });

  test('settings and outbox: the admin can choose the mode, the outbox says no drafts will appear', async ({ page, playwright }) => {
    const api = await playwright.request.newContext();
    try {
      const r = await signInViaApi(api, E.admin, PASSWORD, { host: MARKETING_HOST });
      expect(r.ok, `sign-in: ${r.error}`).toBe(true);
      const put = await api.put('/api/admin/settings', { headers: H, data: { outboundApproval: 'lead_mail_blocked' } });
      expect(put.status()).toBe(200);
      const outbox = await (await api.get('/api/admin/outbox', { headers: H })).json();
      expect(outbox).toMatchObject({ mode: 'lead_mail_blocked', approvalOn: false });
    } finally {
      await api.dispose();
    }

    await page.context().setExtraHTTPHeaders(H);
    await signInAndSettle(page, E.admin, PASSWORD, '/admin');
    await gotoSettled(page, '/admin/settings');
    const select = page.getByTestId('outbound-approval-select');
    await expect(select).toHaveValue('lead_mail_blocked');
    await expect(page.locator('#outbound-approval-hint')).toContainText('No e-mail at all is sent to leads');
    await gotoSettled(page, '/admin/outbox');
    await expect(page.getByTestId('outbox-approval-state')).toHaveAttribute('data-mode', 'lead_mail_blocked');
  });
});
