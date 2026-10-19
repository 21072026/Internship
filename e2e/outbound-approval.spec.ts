import { test, expect, type APIRequestContext } from '@playwright/test';
import { recipientHash } from '@/lib/mailDeliveryRule';
import { expireDrafts, forgetOutboundDrafts } from '@/lib/outboundDrafts';
import {
  mailMeterIdleForTests,
  resetMailTransportsForTests,
  sendContactPermissionConfirmationEmail,
  sendEmail,
  sendTrialReminderEmail,
} from '@/services/emailService';
import { startFakeSmtp, type FakeSmtp } from './helpers/fakeSmtp';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { asHost, gotoSettled, MARKETING_HOST, signInAndSettle, signInViaApi } from './helpers/auth';

// The outbound approval inbox (#2960, docs/outbound-approval.md), end to end.
//
// WHERE THE MAIL IS SENT FROM. The app server Playwright boots runs with
// SMTP_USER blank (no spec may deliver real mail), so every mail it would send
// stops at SKIPPED before the hold is even asked. So, like mail-queue.spec.ts,
// this spec points ITS OWN process at a fake SMTP server and calls the very
// functions the crons and routes call (`sendTrialReminderEmail()`,
// `sendEmail()`). The hold, the sealed draft, the EmailLog row and the Job
// table are the real ones; the outbox API and page then read and decide those
// drafts through the app server, which shares the database and the secret.
//
// Local database only: it writes email.send jobs a deployed drain would race for.
const local = !process.env.BASE_URL;
const PASSWORD = 'OutboxPass123!';
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const E = {
  admin: uniqueEmail(`ob-admin-${STAMP}`),
  rep1: uniqueEmail(`ob-rep1-${STAMP}`),
  rep2: uniqueEmail(`ob-rep2-${STAMP}`),
  lead1: uniqueEmail(`ob-lead1-${STAMP}`),
  lead2: uniqueEmail(`ob-lead2-${STAMP}`),
  offLead: uniqueEmail(`ob-offlead-${STAMP}`),
  foreignAdmin: uniqueEmail(`ob-foreign-${STAMP}`),
  internLead: uniqueEmail(`ob-intern-${STAMP}`),
};
// An address with no account anywhere — a company contact of the org.
const CONTACT = `ob-contact-${STAMP}@acme-sales.example.test`;

const ids: Record<string, string> = {};
const orgIds: string[] = [];
let smtp: FakeSmtp;
const saved: Record<string, string | undefined> = {};
const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'MAIL_INLINE_TIMEOUT_MS', 'MAIL_METER_MODE', 'MAIL_QUEUE_LANES'];

async function org(label: string, approval: 'off' | 'lead_mail' | null) {
  const o = await prisma.organization.create({
    data: { name: `Acme Sales ${label} ${STAMP}`, slug: `ob-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  orgIds.push(o.id);
  if (approval) await prisma.setting.create({ data: { orgId: o.id, key: 'outboundApproval', value: approval } });
  return o.id;
}

async function jobsFor(address: string) {
  const rcpt = recipientHash(address);
  const rows = await prisma.job.findMany({ where: { name: 'email.send' }, orderBy: { createdAt: 'asc' } });
  return rows.filter((r) => (r.payload as { rcpt?: string } | null)?.rcpt === rcpt);
}

const draftsFor = (address: string) =>
  prisma.outboundDraft.findMany({ where: { rcpt: recipientHash(address) }, orderBy: { createdAt: 'asc' } });

/** A fresh held mail to `to` (a lead of `orgId`), through the real send path. */
async function holdOne(to: string, userId: string | null, orgId: string, subject: string) {
  const result = await sendEmail({
    to,
    subject,
    html: `<p>Hello from the e2e outbox — ${subject}</p><script>window.parent.__outboxScriptRan = true</script>`,
    category: 'dormant-check-in',
    userId,
    orgId,
  });
  expect(result).toBe('HELD');
  const rows = (await draftsFor(to)).filter((d) => d.status === 'DRAFT');
  return rows[rows.length - 1];
}

async function apiAs(request: APIRequestContext, email: string) {
  const r = await signInViaApi(request, email, PASSWORD, { host: MARKETING_HOST });
  expect(r.ok, `sign-in ${email}: ${r.error}`).toBe(true);
}

const H = asHost(MARKETING_HOST);

test.describe('outbound approval', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!local, 'sends mail from this process against the local database and a fake SMTP server');

  test.beforeAll(async () => {
    smtp = await startFakeSmtp();
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_USER = 'outbox-e2e';
    process.env.SMTP_PASS = 'outbox-e2e';
    process.env.SMTP_FROM = 'noreply@example.test';
    process.env.NEXTAUTH_SECRET ||= 'e2e-outbox-secret';
    delete process.env.MAIL_METER_MODE;
    delete process.env.MAIL_INLINE_TIMEOUT_MS;
    delete process.env.MAIL_QUEUE_LANES;
    resetMailTransportsForTests();

    ids.org = await org('on', 'lead_mail');
    ids.offOrg = await org('off', null);
    ids.foreignOrg = await org('foreign', 'lead_mail');
    ids.admin = (await seedUser(E.admin, PASSWORD, 'ADMIN', `Outbox Admin ${STAMP}`, ids.org)).id;
    ids.rep1 = (await seedUser(E.rep1, PASSWORD, 'MENTOR', `Outbox Rep One ${STAMP}`, ids.org)).id;
    ids.rep2 = (await seedUser(E.rep2, PASSWORD, 'MENTOR', `Outbox Rep Two ${STAMP}`, ids.org)).id;
    ids.lead1 = (await seedUser(E.lead1, PASSWORD, 'MENTEE', `Lead One ${STAMP}`, ids.org)).id;
    ids.lead2 = (await seedUser(E.lead2, PASSWORD, 'MENTEE', `Lead Two ${STAMP}`, ids.org)).id;
    ids.offLead = (await seedUser(E.offLead, PASSWORD, 'MENTEE', `Off Lead ${STAMP}`, ids.offOrg)).id;
    ids.foreignAdmin = (await seedUser(E.foreignAdmin, PASSWORD, 'ADMIN', `Foreign Admin ${STAMP}`, ids.foreignOrg)).id;
    // A person of the default (internship) world: the switch can never touch them.
    ids.internLead = (await seedUser(E.internLead, PASSWORD, 'MENTEE', `Intern Person ${STAMP}`, null)).id;
    await prisma.mentorshipRelation.create({ data: { orgId: ids.org, mentorId: ids.rep1, menteeId: ids.lead1 } });
    await prisma.mentorshipRelation.create({ data: { orgId: ids.org, mentorId: ids.rep2, menteeId: ids.lead2 } });
  });

  test.afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetMailTransportsForTests();
    await mailMeterIdleForTests().catch(() => {});
    const drafts = await prisma.outboundDraft.findMany({ where: { orgId: { in: orgIds } }, select: { id: true } }).catch(() => []);
    await prisma.job
      .deleteMany({ where: { name: 'email.send', idempotencyKey: { in: drafts.map((d) => `draft:${d.id}`) } } })
      .catch(() => {});
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

  test(
    'approval on: a trial reminder addressed to a lead becomes a draft — no mail, no job — and only once',
    { tag: '@smoke' },
    async () => {
      const reminder = {
        to: E.lead1,
        fullName: 'Lead One',
        companyName: 'Acme Sales',
        trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        threshold: 3,
        link: '/sales',
        orgId: ids.org,
        userId: ids.lead1,
      };
      await sendTrialReminderEmail(reminder);
      // The cron runs again (another replica, tomorrow's tick): still one draft.
      await sendTrialReminderEmail(reminder);

      expect(smtp.to(E.lead1)).toHaveLength(0);
      expect(await jobsFor(E.lead1)).toHaveLength(0);
      const drafts = await draftsFor(E.lead1);
      expect(drafts).toHaveLength(1);
      const [draft] = drafts;
      expect(draft.orgId).toBe(ids.org);
      expect(draft.status).toBe('DRAFT');
      expect(draft.category).toBe('stage-deadline');
      expect(draft.trigger).toBe('deadline');
      expect(draft.reason).toBe('held_lead');
      expect(draft.recipientUserId).toBe(ids.lead1);
      // Sealed: neither the address nor the body is readable on the row.
      expect(draft.box).toBeTruthy();
      expect(draft.box).not.toContain(E.lead1);
      expect(draft.box).not.toContain('Acme Sales');
      expect(draft.summary).not.toContain(E.lead1);
      // The ledger says what happened, once.
      const log = await prisma.emailLog.findMany({ where: { to: E.lead1 } });
      expect(log.map((l) => l.status)).toEqual(['HELD']);
    },
  );

  test('exempt mail still goes out with approval on: security, the double opt-in, and mail to staff', async () => {
    const security = await sendEmail({ to: E.lead1, subject: `Security ${STAMP}`, html: '<p>sec</p>', category: 'security', userId: ids.lead1 });
    expect(security).toBe('SENT');
    const doi = await sendContactPermissionConfirmationEmail({
      to: CONTACT,
      contactName: 'Contact Person',
      companyName: 'Acme Sales',
      confirmUrl: 'https://acme-sales.example.test/confirm',
      optOutUrl: 'https://acme-sales.example.test/optout',
      orgId: ids.org,
    });
    expect(doi).toBe('SENT');
    const toStaff = await sendEmail({ to: E.rep1, subject: `Deadline ${STAMP}`, html: '<p>staff</p>', category: 'stage-deadline', userId: ids.rep1, orgId: ids.org });
    expect(toStaff).toBe('SENT');
    expect(smtp.to(CONTACT)).toHaveLength(1);
    expect(smtp.to(E.rep1)).toHaveLength(1);
    expect(await draftsFor(CONTACT)).toHaveLength(0);
    expect(await draftsFor(E.rep1)).toHaveLength(0);

    // An unknown category to a contact of the org is held (fail safe).
    const unknown = await sendEmail({ to: CONTACT, subject: `Unknown ${STAMP}`, html: '<p>?</p>', category: 'never-classified', orgId: ids.org });
    expect(unknown).toBe('HELD');
    const [held] = await draftsFor(CONTACT);
    expect(held.reason).toBe('held_contact');
    expect(held.trigger).toBe('other');
  });

  test('approval off: mail behaves exactly as before — sent, no draft', async () => {
    const off = await sendEmail({ to: E.offLead, subject: `Off ${STAMP}`, html: '<p>off</p>', category: 'stage-deadline', userId: ids.offLead });
    expect(off).toBe('SENT');
    const intern = await sendEmail({ to: E.internLead, subject: `Intern ${STAMP}`, html: '<p>i</p>', category: 'dormant-check-in', userId: ids.internLead });
    expect(intern).toBe('SENT');
    expect(smtp.to(E.offLead)).toHaveLength(1);
    expect(smtp.to(E.internLead)).toHaveLength(1);
    expect(await draftsFor(E.offLead)).toHaveLength(0);
    expect(await draftsFor(E.internLead)).toHaveLength(0);
  });

  test('who sees which draft: the admin all of the org, a rep only their own leads, another org nothing', { tag: '@smoke' }, async ({ playwright }) => {
    const d1 = await holdOne(E.lead1, ids.lead1, ids.org, `Scope one ${STAMP}`);
    const d2 = await holdOne(E.lead2, ids.lead2, ids.org, `Scope two ${STAMP}`);

    const admin = await playwright.request.newContext();
    const rep1 = await playwright.request.newContext();
    const foreign = await playwright.request.newContext();
    try {
      await apiAs(admin, E.admin);
      await apiAs(rep1, E.rep1);
      await apiAs(foreign, E.foreignAdmin);

      const all = await (await admin.get('/api/admin/outbox', { headers: H })).json();
      const allIds = all.drafts.map((d: { id: string }) => d.id);
      expect(allIds).toEqual(expect.arrayContaining([d1.id, d2.id]));
      expect(all.approvalOn).toBe(true);
      expect(all.scope).toBe('org');
      // No full address in a list row.
      expect(JSON.stringify(all)).not.toContain(E.lead1);

      const own = await (await rep1.get('/api/admin/outbox', { headers: H })).json();
      const ownIds = own.drafts.map((d: { id: string }) => d.id);
      expect(ownIds).toContain(d1.id);
      expect(ownIds).not.toContain(d2.id);
      expect(own.scope).toBe('own');
      // Somebody else's lead: not found, for reading and for every action.
      expect((await rep1.get(`/api/admin/outbox/${d2.id}`, { headers: H })).status()).toBe(404);
      for (const action of ['send', 'discard']) {
        expect((await rep1.post(`/api/admin/outbox/${d2.id}/${action}`, { headers: H })).status()).toBe(404);
      }
      const bulk = await (await rep1.post('/api/admin/outbox/bulk', { headers: H, data: { action: 'discard', ids: [d2.id] } })).json();
      expect(bulk).toEqual({ done: [], skipped: [{ id: d2.id, code: 'not_found' }] });

      // Another organization's admin: not found, and their own list is empty of ours.
      expect((await foreign.get(`/api/admin/outbox/${d1.id}`, { headers: H })).status()).toBe(404);
      expect((await foreign.post(`/api/admin/outbox/${d1.id}/send`, { headers: H })).status()).toBe(404);
      const theirs = await (await foreign.get('/api/admin/outbox', { headers: H })).json();
      expect(theirs.drafts.map((d: { id: string }) => d.id)).not.toContain(d1.id);

      // Nothing moved.
      for (const d of [d1, d2]) expect((await prisma.outboundDraft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('DRAFT');
      expect(await jobsFor(E.lead2)).toHaveLength(0);
    } finally {
      await Promise.all([admin.dispose(), rep1.dispose(), foreign.dispose()]);
    }
  });

  test('the admin previews a draft in a sandboxed frame and sends it: exactly one email.send job', async ({ page }) => {
    test.slow();
    const draft = await holdOne(E.lead1, ids.lead1, ids.org, `Preview me ${STAMP}`);
    await page.context().setExtraHTTPHeaders(H);
    await signInAndSettle(page, E.admin, PASSWORD, '/admin');
    await gotoSettled(page, '/admin/outbox');
    const row = page.getByTestId(`outbox-row-${draft.id}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('outbox-subject')).toHaveText(`Preview me ${STAMP}`);
    await expect(row.getByTestId('outbox-recipient-masked')).not.toHaveText(E.lead1);
    await expect(page.getByTestId('outbox-badge').first()).toBeVisible();

    await row.getByTestId(`outbox-preview-${draft.id}`).click();
    const preview = page.getByTestId('outbox-preview');
    await expect(preview.getByTestId('outbox-preview-to')).toHaveText(E.lead1);
    const frame = preview.getByTestId('outbox-preview-frame');
    // An EMPTY sandbox: no scripts, no same-origin.
    await expect(frame).toHaveAttribute('sandbox', '');
    await expect(page.frameLocator('[data-testid="outbox-preview-frame"]').getByText(`Preview me ${STAMP}`)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __outboxScriptRan?: boolean }).__outboxScriptRan ?? false)).toBe(false);

    await preview.getByTestId('outbox-preview-send').click();
    await expect(page.getByTestId(`outbox-row-${draft.id}`)).toHaveCount(0);
    const after = await prisma.outboundDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe('SENT');
    expect(after.box).toBeNull();
    expect(after.decidedById).toBe(ids.admin);
    const jobs = await prisma.job.findMany({ where: { idempotencyKey: `draft:${draft.id}` } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(after.jobId);
    expect(jobs[0].orgId).toBe(ids.org);
    expect((jobs[0].payload as { reason?: string }).reason).toBe('approved');
    expect(
      await prisma.auditLog.count({ where: { action: 'outbound_draft.send', targetId: draft.id, orgId: ids.org } }),
    ).toBe(1);

    // Decided once: a second send is a conflict and queues nothing more.
    const again = await page.request.post(`/api/admin/outbox/${draft.id}/send`, { headers: H });
    expect(again.status()).toBe(409);
    expect(await prisma.job.count({ where: { idempotencyKey: `draft:${draft.id}` } })).toBe(1);
  });

  test('schedule puts the mail on the queue for that time; discard sends nothing; bulk reports honestly', async ({ playwright }) => {
    const toSchedule = await holdOne(E.lead1, ids.lead1, ids.org, `Schedule me ${STAMP}`);
    const toDiscard = await holdOne(E.lead1, ids.lead1, ids.org, `Discard me ${STAMP}`);
    const bulkA = await holdOne(E.lead1, ids.lead1, ids.org, `Bulk A ${STAMP}`);
    const bulkB = await holdOne(E.lead1, ids.lead1, ids.org, `Bulk B ${STAMP}`);
    const rep1 = await playwright.request.newContext();
    try {
      await apiAs(rep1, E.rep1);
      const at = new Date(Date.now() + 2 * 60 * 60 * 1000);
      at.setUTCSeconds(0, 0);
      expect((await rep1.post(`/api/admin/outbox/${toSchedule.id}/schedule`, { headers: H, data: { at: new Date(Date.now() - 60_000).toISOString() } })).status()).toBe(409);
      const scheduled = await rep1.post(`/api/admin/outbox/${toSchedule.id}/schedule`, { headers: H, data: { at: at.toISOString() } });
      expect(scheduled.status()).toBe(200);
      const s = await prisma.outboundDraft.findUniqueOrThrow({ where: { id: toSchedule.id } });
      expect(s.status).toBe('SCHEDULED');
      expect(s.scheduledFor?.getTime()).toBe(at.getTime());
      const [job] = await prisma.job.findMany({ where: { idempotencyKey: `draft:${toSchedule.id}` } });
      expect(job.status).toBe('PENDING');
      expect(job.runAt.getTime()).toBe(at.getTime());

      expect((await rep1.post(`/api/admin/outbox/${toDiscard.id}/discard`, { headers: H })).status()).toBe(200);
      const d = await prisma.outboundDraft.findUniqueOrThrow({ where: { id: toDiscard.id } });
      expect(d.status).toBe('DISCARDED');
      expect(d.box).toBeNull();
      expect(await prisma.job.count({ where: { idempotencyKey: `draft:${toDiscard.id}` } })).toBe(0);

      const bulk = await (
        await rep1.post('/api/admin/outbox/bulk', { headers: H, data: { action: 'discard', ids: [bulkA.id, bulkB.id, toDiscard.id] } })
      ).json();
      expect(bulk.done.sort()).toEqual([bulkA.id, bulkB.id].sort());
      expect(bulk.skipped).toEqual([{ id: toDiscard.id, code: 'not_pending' }]);
    } finally {
      await rep1.dispose();
    }
    // Nothing of the above reached the lead's inbox.
    expect(smtp.to(E.lead1).filter((m) => !m.data.includes(`Security ${STAMP}`))).toHaveLength(0);
  });

  test('an undecided draft expires at its deadline, and erasure removes the drafts of the person', async () => {
    const old = await holdOne(E.lead2, ids.lead2, ids.org, `Expire me ${STAMP}`);
    await prisma.outboundDraft.update({ where: { id: old.id }, data: { notAfter: new Date(Date.now() - 1000) } });
    expect(await expireDrafts()).toBeGreaterThanOrEqual(1);
    const expired = await prisma.outboundDraft.findUniqueOrThrow({ where: { id: old.id } });
    expect(expired.status).toBe('EXPIRED');
    expect(expired.box).toBeNull();

    const n = await forgetOutboundDrafts({ userId: ids.lead2, address: E.lead2, orgId: ids.org });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await draftsFor(E.lead2)).toHaveLength(0);
    // The other lead's drafts are untouched.
    expect((await draftsFor(E.lead1)).length).toBeGreaterThan(0);
  });

  test('the setting is refused for an internship organization', async ({ playwright }) => {
    const internAdminEmail = uniqueEmail(`ob-intern-admin-${STAMP}`);
    await seedUser(internAdminEmail, PASSWORD, 'ADMIN', `Intern Admin ${STAMP}`, null);
    const ctx = await playwright.request.newContext();
    try {
      const r = await signInViaApi(ctx, internAdminEmail, PASSWORD);
      expect(r.ok).toBe(true);
      const put = await ctx.put('/api/admin/settings', { data: { outboundApproval: 'lead_mail' } });
      expect(put.status()).toBe(400);
      expect((await put.json()).field).toBe('outboundApproval');
      // …and the outbox does not exist there.
      expect((await ctx.get('/api/admin/outbox')).status()).toBe(403);
    } finally {
      await ctx.dispose();
      await cleanupByEmail(internAdminEmail);
    }
  });
});
