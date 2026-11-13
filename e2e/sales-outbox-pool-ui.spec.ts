import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { recipientHash } from '@/lib/mailDeliveryRule';
import { mailMeterIdleForTests, resetMailTransportsForTests, sendEmail } from '@/services/emailService';
import { startFakeSmtp, type FakeSmtp } from './helpers/fakeSmtp';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { asHost, gotoSettled, MARKETING_HOST, signInAndSettle, signInViaApi } from './helpers/auth';
import { PLACEHOLDER_EMAIL_DOMAIN } from '../src/lib/menteeAccount';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// The sales rep's screens, driven through the UI (P5). What the API specs
// already pin is not repeated here — outbound-approval.spec.ts covers the
// outbox API (visibility, bulk API answers, the admin's preview-and-send) and
// klaviyo-connector.spec.ts the pool API (list, claim, 409 on a second claim).
// What nothing drove before is the rep's side of the glass:
//
//   OUTBOX (/sales/outbox)
//     • a rep sees the held mail of their OWN leads and not a colleague's;
//     • select-all → bulk discard asks first, then settles every row and queues
//       nothing; the toggle-each → bulk send path queues exactly one job each.
//   POOL (the card on /sales)
//     • "Take it" puts the lead on the rep's own book and opens its page; the
//       row leaves the pool;
//     • a colleague who was faster: the card says so, the row disappears, and
//       the lead keeps ONE record (the colleague's);
//     • the pool is the rep's own org's — another org's lead is neither listed
//       nor claimable (404), and the card ends on its empty state.
//
// Local database only: the outbox half sends mail from this process through a
// fake SMTP server (the same set-up as outbound-approval.spec.ts) and writes
// email.send jobs a deployed drain would race for.
const local = !process.env.BASE_URL;
const PASSWORD = 'SalesUiPass123!';
const STAMP = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const H = asHost(MARKETING_HOST);

const E = {
  rep1: uniqueEmail(`sui-rep1-${STAMP}`),
  rep2: uniqueEmail(`sui-rep2-${STAMP}`),
  lead1: uniqueEmail(`sui-lead1-${STAMP}`),
  lead2: uniqueEmail(`sui-lead2-${STAMP}`),
  foreignRep: uniqueEmail(`sui-frep-${STAMP}`),
};
const ids: Record<string, string> = {};
const orgIds: string[] = [];
const poolEmails: string[] = [];
let smtp: FakeSmtp;
const saved: Record<string, string | undefined> = {};
const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'MAIL_INLINE_TIMEOUT_MS', 'MAIL_METER_MODE', 'MAIL_QUEUE_LANES'];

async function marketingOrg(label: string, approval: boolean) {
  const o = await prisma.organization.create({
    data: { name: `Acme Sales ${label} ${STAMP}`, slug: `sui-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  orgIds.push(o.id);
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId: o.id,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  if (approval) await prisma.setting.create({ data: { orgId: o.id, key: 'outboundApproval', value: 'lead_mail' } });
  return o.id;
}

/** An unassigned lead the way a machine leaves one: an account, a stand-in lead person, no record. */
async function poolLead(orgId: string, label: string) {
  const company = await prisma.company.create({
    data: { orgId, name: `Acme ${label} ${STAMP}`, contactEmail: `buyer.${label}.${STAMP}@acme.example` },
  });
  const email = `pool-${label}-${STAMP}@${PLACEHOLDER_EMAIL_DOMAIN}`.toLowerCase();
  poolEmails.push(email);
  const lead = await seedUser(email, 'not-a-login-123', 'MENTEE', `Pool ${label} ${STAMP}`, orgId);
  await prisma.user.update({ where: { id: lead.id }, data: { companyId: company.id } });
  return lead.id;
}

/** A fresh held mail to `to` (a lead of `orgId`), through the real send path. */
async function holdOne(to: string, userId: string, orgId: string, subject: string) {
  const result = await sendEmail({ to, subject, html: `<p>${subject}</p>`, category: 'dormant-check-in', userId, orgId });
  expect(result).toBe('HELD');
  const rows = await prisma.outboundDraft.findMany({
    where: { rcpt: recipientHash(to), status: 'DRAFT' },
    orderBy: { createdAt: 'asc' },
  });
  return rows[rows.length - 1];
}

test.describe('sales rep screens: outbox and lead pool', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!local, 'sends mail from this process against the local database and a fake SMTP server');

  test.beforeAll(async () => {
    smtp = await startFakeSmtp();
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_USER = 'sales-ui-e2e';
    process.env.SMTP_PASS = 'sales-ui-e2e';
    process.env.SMTP_FROM = 'noreply@example.test';
    process.env.NEXTAUTH_SECRET ||= 'e2e-sales-ui-secret';
    delete process.env.MAIL_METER_MODE;
    delete process.env.MAIL_INLINE_TIMEOUT_MS;
    delete process.env.MAIL_QUEUE_LANES;
    resetMailTransportsForTests();

    ids.org = await marketingOrg('on', true);
    ids.foreignOrg = await marketingOrg('foreign', false);
    ids.rep1 = (await seedUser(E.rep1, PASSWORD, 'MENTOR', `Sales Rep One ${STAMP}`, ids.org)).id;
    ids.rep2 = (await seedUser(E.rep2, PASSWORD, 'MENTOR', `Sales Rep Two ${STAMP}`, ids.org)).id;
    ids.lead1 = (await seedUser(E.lead1, PASSWORD, 'MENTEE', `Lead One ${STAMP}`, ids.org)).id;
    ids.lead2 = (await seedUser(E.lead2, PASSWORD, 'MENTEE', `Lead Two ${STAMP}`, ids.org)).id;
    ids.foreignRep = (await seedUser(E.foreignRep, PASSWORD, 'MENTOR', `Foreign Rep ${STAMP}`, ids.foreignOrg)).id;
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
    await prisma.job.deleteMany({ where: { name: 'email.send', idempotencyKey: { in: drafts.map((d) => `draft:${d.id}`) } } }).catch(() => {});
    for (const address of Object.values(E)) await prisma.emailLog.deleteMany({ where: { to: address } }).catch(() => {});
    await prisma.outboundDraft.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
    await prisma.statusChange.deleteMany({ where: { relation: { orgId: { in: orgIds } } } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
    for (const email of [...Object.values(E), ...poolEmails]) await cleanupByEmail(email);
    await prisma.company.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
    await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
    await prisma.setting.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
    await smtp?.close();
  });

  test('outbox: a rep sees only their own leads\' mail; select-all → bulk discard asks first and queues nothing', async ({ page }) => {
    const mineA = await holdOne(E.lead1, ids.lead1, ids.org, `Mine A ${STAMP}`);
    const mineB = await holdOne(E.lead1, ids.lead1, ids.org, `Mine B ${STAMP}`);
    const colleagues = await holdOne(E.lead2, ids.lead2, ids.org, `Colleague ${STAMP}`);

    await page.context().setExtraHTTPHeaders(H);
    await signInAndSettle(page, E.rep1, PASSWORD, '/sales');
    await gotoSettled(page, '/sales/outbox');
    await expect(page.getByTestId(`outbox-row-${mineA.id}`)).toBeVisible();
    await expect(page.getByTestId(`outbox-row-${mineB.id}`)).toBeVisible();
    await expect(page.getByTestId(`outbox-row-${colleagues.id}`)).toHaveCount(0);

    await page.getByTestId('outbox-select-all').check();
    await expect(page.getByTestId('outbox-selected-count')).toContainText('2');
    await page.getByTestId('outbox-bulk-discard').click();
    // Asks first: cancelling changes nothing.
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId(`outbox-row-${mineA.id}`)).toBeVisible();
    expect((await prisma.outboundDraft.findUniqueOrThrow({ where: { id: mineA.id } })).status).toBe('DRAFT');

    await page.getByTestId('outbox-bulk-discard').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId(`outbox-row-${mineA.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`outbox-row-${mineB.id}`)).toHaveCount(0);
    await expect(page.getByTestId('outbox-flash')).toContainText('2');

    for (const d of [mineA, mineB]) {
      const row = await prisma.outboundDraft.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.status).toBe('DISCARDED');
      expect(row.decidedById).toBe(ids.rep1);
      expect(await prisma.job.count({ where: { idempotencyKey: `draft:${d.id}` } })).toBe(0);
    }
    // The colleague's draft is untouched by the rep's bulk action.
    expect((await prisma.outboundDraft.findUniqueOrThrow({ where: { id: colleagues.id } })).status).toBe('DRAFT');
    expect(smtp.to(E.lead1)).toHaveLength(0);
  });

  test('outbox: ticking rows one by one → bulk send queues exactly one job per draft', async ({ page }) => {
    const one = await holdOne(E.lead1, ids.lead1, ids.org, `Send one ${STAMP}`);
    const two = await holdOne(E.lead1, ids.lead1, ids.org, `Send two ${STAMP}`);

    await page.context().setExtraHTTPHeaders(H);
    await signInAndSettle(page, E.rep1, PASSWORD, '/sales');
    await gotoSettled(page, '/sales/outbox');
    await page.getByTestId(`outbox-select-${one.id}`).check();
    await page.getByTestId(`outbox-select-${two.id}`).check();
    await expect(page.getByTestId('outbox-selected-count')).toContainText('2');
    await page.getByTestId('outbox-bulk-send').click();
    await expect(page.getByTestId(`outbox-row-${one.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`outbox-row-${two.id}`)).toHaveCount(0);

    for (const d of [one, two]) {
      const row = await prisma.outboundDraft.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.status).toBe('SENT');
      expect(row.decidedById).toBe(ids.rep1);
      const jobs = await prisma.job.findMany({ where: { idempotencyKey: `draft:${d.id}` } });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(row.jobId);
    }
  });

  test('pool: "Take it" puts the lead on the rep\'s own book and opens it; a faster colleague is reported; another org\'s lead is out of reach', async ({ page, playwright }) => {
    const mine = await poolLead(ids.org, 'mine');
    const raced = await poolLead(ids.org, 'raced');
    const foreign = await poolLead(ids.foreignOrg, 'foreign');

    await page.context().setExtraHTTPHeaders(H);
    await signInAndSettle(page, E.rep1, PASSWORD, '/sales');
    const card = page.getByTestId('lead-pool');
    await expect(card.getByTestId(`lead-pool-row-${mine}`)).toBeVisible();
    await expect(card.getByTestId(`lead-pool-row-${raced}`)).toBeVisible();
    await expect(card.getByTestId(`lead-pool-row-${foreign}`)).toHaveCount(0);

    // A colleague takes `raced` after the rep's page has loaded.
    const rep2 = await playwright.request.newContext({ extraHTTPHeaders: H });
    try {
      expect((await signInViaApi(rep2, E.rep2, PASSWORD, { host: MARKETING_HOST })).ok).toBe(true);
      expect((await rep2.post(`/api/sales/pool/${raced}/claim`)).status()).toBe(201);
      // Another org's lead: not in this org's pool, and no 403 that would confirm the id.
      expect((await rep2.post(`/api/sales/pool/${foreign}/claim`)).status()).toBe(404);
    } finally {
      await rep2.dispose();
    }
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: foreign } })).toBe(0);

    await card.getByTestId(`lead-pool-take-${raced}`).click();
    await expect(card.getByTestId('lead-pool-message')).toHaveText('A colleague took that lead first.');
    await expect(card.getByTestId(`lead-pool-row-${raced}`)).toHaveCount(0);
    const racedRecords = await prisma.mentorshipRelation.findMany({ where: { menteeId: raced } });
    expect(racedRecords).toHaveLength(1);
    expect(racedRecords[0].mentorId).toBe(ids.rep2);

    // Taking `mine`: the rep's own record, opened on its lead page.
    await card.getByTestId(`lead-pool-take-${mine}`).click();
    await page.waitForURL(/\/sales\/leads\/[^/]+$/);
    const record = await prisma.mentorshipRelation.findFirstOrThrow({ where: { menteeId: mine } });
    expect(record.mentorId).toBe(ids.rep1);
    expect(record.orgId).toBe(ids.org);
    expect(page.url()).toContain(`/sales/leads/${record.id}`);

    // Back on the dashboard the pool is empty for this org — the foreign lead never counts.
    await gotoSettled(page, '/sales');
    await expect(page.getByTestId('lead-pool-empty')).toBeVisible();
  });
});
