import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';
import { E2E_HEALTH_TOKEN } from '../playwright.config';

// The mail queue's operations surface (#2953): the Queue tab's API and its two
// actions, who may use them, and the health endpoint's `mail` block.
//
// The app server Playwright boots sends no mail and runs no drain (SMTP_USER is
// blank), so rows seeded here stay exactly where the test puts them: what is
// asserted is the authorization, the guarded writes, the audit trail and that
// no address ever leaves the server — not delivery, which e2e/mail-queue.spec.ts
// covers against a fake relay.

const RUN = Date.now().toString(36);
const PW = 'MailQueuePass123';
const HASH = (c: string) => c.repeat(64);
const SECRET_ADDRESS = `mq-secret-${RUN}@example.test`;

const superAdminEmail = uniqueEmail('mq-super');
const defaultAdminEmail = uniqueEmail('mq-default-admin');
const tenantAdminEmail = uniqueEmail('mq-tenant-admin');

let defaultOrgId = '';
let tenantOrgId = '';
let marketingOrgId = '';
const jobIds: string[] = [];

async function mkJob(
  label: string,
  data: {
    status: 'PENDING' | 'DEAD_LETTER' | 'FAILED';
    orgId: string | null;
    lane?: string;
    priority?: number;
    notAfterMs?: number;
    box?: string | null;
    world?: string;
    ref?: string | null;
  },
) {
  const notAfter = new Date(Date.now() + (data.notAfterMs ?? 60 * 60 * 1000)).toISOString();
  const job = await prisma.job.create({
    data: {
      name: 'email.send',
      status: data.status,
      priority: data.priority ?? 50,
      attempts: data.status === 'PENDING' ? 0 : 5,
      maxAttempts: 5,
      // A relay's free text would echo the address: the screen must never show it.
      lastError: data.status === 'PENDING' ? null : label === 'raw' ? `550 <${SECRET_ADDRESS}> no such user` : 'smtp_550_5.1.1',
      idempotencyKey: `e2e-mq:${RUN}:${label}`,
      orgId: data.orgId,
      payload: {
        v: 1,
        lane: data.lane ?? 'TRANSACTIONAL',
        category: 'message',
        group: 'direct_messages',
        userId: null,
        orgId: data.orgId,
        world: data.world ?? 'INTERNSHIP',
        rcpt: HASH(label.length % 2 ? 'a' : 'b'),
        notAfter,
        reason: 'retry',
        ref: data.ref ?? null,
        box: data.box === undefined ? `sealed-envelope-${RUN}` : data.box,
      },
    },
  });
  jobIds.push(job.id);
  return job;
}

let tenantDead = '';
let tenantDeadRaw = '';
let defaultPending = '';
let defaultDeadExpired = '';
let marketingDead = '';
let orglessDead = '';
let superAdminId = '';
const newsletterIds: string[] = [];

test.beforeAll(async () => {
  const def = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
  defaultOrgId = def.id;
  tenantOrgId = (await prisma.organization.create({ data: { name: `MQ Tenant ${RUN}`, slug: `mq-tenant-${RUN}` } })).id;
  marketingOrgId = (
    await prisma.organization.create({ data: { name: `MQ Marketing ${RUN}`, slug: `mq-mkt-${RUN}`, vertical: 'MARKETING' } })
  ).id;

  const superAdmin = await seedUser(superAdminEmail, PW, 'ADMIN', 'MQ Super', defaultOrgId);
  await prisma.user.update({ where: { id: superAdmin.id }, data: { isSuperAdmin: true } });
  superAdminId = superAdmin.id;
  await seedUser(defaultAdminEmail, PW, 'ADMIN', 'MQ Default Admin', defaultOrgId);
  await seedUser(tenantAdminEmail, PW, 'ADMIN', 'MQ Tenant Admin', tenantOrgId);

  tenantDead = (await mkJob('tenant-dead', { status: 'DEAD_LETTER', orgId: tenantOrgId })).id;
  tenantDeadRaw = (await mkJob('raw', { status: 'FAILED', orgId: tenantOrgId })).id;
  defaultPending = (await mkJob('default-pending', { status: 'PENDING', orgId: defaultOrgId, lane: 'CRITICAL', priority: 100 })).id;
  defaultDeadExpired = (await mkJob('default-expired', { status: 'DEAD_LETTER', orgId: defaultOrgId, notAfterMs: -60_000 })).id;
  marketingDead = (await mkJob('mkt-dead', { status: 'DEAD_LETTER', orgId: marketingOrgId, world: 'MARKETING', lane: 'BULK', priority: 0 })).id;
  // A send that named neither an org nor a user is queued without one — it may
  // be any tenant's mail, so it is the super admin's, not the default org's.
  orglessDead = (await mkJob('orgless-dead', { status: 'DEAD_LETTER', orgId: null })).id;
});

test.afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { targetId: { in: jobIds } } });
  await prisma.activityLog.deleteMany({ where: { targetId: { in: jobIds } } });
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.newsletter.deleteMany({ where: { id: { in: newsletterIds } } });
  for (const e of [superAdminEmail, defaultAdminEmail, tenantAdminEmail]) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: { in: [tenantOrgId, marketingOrgId] } } }).catch(() => {});
  await prisma.$disconnect();
});

type View = {
  scope: string;
  counts: Record<string, Record<string, number>>;
  dead: { id: string; reason: string | null; rcpt: string | null; actionable: boolean; refusal: string | null }[];
  waiting: { id: string }[];
  breaker: Record<string, { paused: boolean; pausedUntil: string | null; pauseLevel: number }>;
  day?: Record<string, { count: number; cap: number | null }>;
};

async function view(page: Page): Promise<{ status: number; body: View | null; text: string }> {
  const res = await page.request.get('/api/admin/mail-queue');
  const text = await res.text();
  return { status: res.status(), body: res.ok() ? (JSON.parse(text) as View) : null, text };
}

test(
  'the queue is an operator surface: a tenant admin is refused; the default org admin sees only its own rows',
  { tag: '@smoke' },
  async ({ page }) => {
    // A tenant admin: no view, no action — not even on its own tenant's mail.
    await signInAsFreshUser(page, tenantAdminEmail, PW, '/admin');
    expect((await page.request.get('/api/admin/mail-queue?probe=1')).status()).toBe(403);
    const refused = await view(page);
    expect(refused.status).toBe(403);
    expect(refused.text).not.toContain(tenantDead);
    for (const action of ['retry', 'cancel']) {
      for (const id of [tenantDead, defaultPending]) {
        const res = await page.request.post(`/api/admin/mail-queue/${id}/${action}`);
        expect(res.status(), `tenant admin ${action} ${id}`).toBe(403);
      }
    }
    expect((await prisma.job.findUniqueOrThrow({ where: { id: tenantDead } })).status).toBe('DEAD_LETTER');
    expect((await prisma.job.findUniqueOrThrow({ where: { id: defaultPending } })).status).toBe('PENDING');
    // And the health endpoint's mail block is not theirs either.
    const health = await page.request.get('/api/health?jobs=1');
    const hb = await health.json();
    expect(hb.jobs).toBeDefined(); // an ADMIN still reads the generic counters…
    expect(hb.mail).toBeUndefined(); // …but not every tenant's mail volume

    // The default organization's ADMIN: its own rows and system mail, never a tenant's.
    await signInAsFreshUser(page, defaultAdminEmail, PW, '/admin');
    const own = await view(page);
    expect(own.status).toBe(200);
    expect(own.body!.scope).toBe('organization');
    expect(own.body!.waiting.map((r) => r.id)).toContain(defaultPending);
    expect(own.text).not.toContain(tenantDead);
    expect(own.text).not.toContain(marketingDead);
    expect(own.text).not.toContain(orglessDead);
    expect(own.body!.day).toBeUndefined();
    // Another tenant's id reads exactly like a missing one.
    expect((await page.request.post(`/api/admin/mail-queue/${tenantDead}/retry`)).status()).toBe(404);
    expect((await page.request.post(`/api/admin/mail-queue/nope-${RUN}/retry`)).status()).toBe(404);
    expect((await page.request.post(`/api/admin/mail-queue/${orglessDead}/cancel`)).status()).toBe(404);
    expect((await page.request.post(`/api/admin/mail-queue/${orglessDead}/retry`)).status()).toBe(404);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: orglessDead } })).status).toBe('DEAD_LETTER');
    expect((await prisma.job.findUniqueOrThrow({ where: { id: tenantDead } })).status).toBe('DEAD_LETTER');
  },
);

test('a super admin sees the world, never an address; retry and cancel are guarded and audited', async ({ page }) => {
  await signInAsFreshUser(page, superAdminEmail, PW, '/admin');
  const v = await view(page);
  expect(v.status).toBe(200);
  const body = v.body!;
  expect(body.scope).toBe('world');
  const deadIds = body.dead.map((r) => r.id);
  expect(deadIds).toEqual(expect.arrayContaining([tenantDead, tenantDeadRaw, defaultDeadExpired, orglessDead]));
  // The other product's mail is the other world's operator's.
  expect(v.text).not.toContain(marketingDead);
  // No address, no envelope, no relay text: a code or `other`, and a 12-char fingerprint.
  expect(v.text).not.toContain(SECRET_ADDRESS);
  expect(v.text).not.toContain(`sealed-envelope-${RUN}`);
  const raw = body.dead.find((r) => r.id === tenantDeadRaw)!;
  expect(raw.reason).toBe('other');
  expect(raw.rcpt).toMatch(/^[0-9a-f]{12}$/);
  expect(body.dead.find((r) => r.id === tenantDead)!.reason).toBe('smtp_550_5.1.1');
  expect(body.dead.find((r) => r.id === defaultDeadExpired)).toMatchObject({ actionable: false, refusal: 'expired' });
  expect(body.counts.CRITICAL.PENDING).toBeGreaterThanOrEqual(1);
  expect(body.day?.primary).toBeDefined();

  // Retry: back to PENDING with its attempts reset, one audit row in the row's tenant.
  const retried = await page.request.post(`/api/admin/mail-queue/${tenantDead}/retry`);
  expect(retried.status()).toBe(200);
  const row = await prisma.job.findUniqueOrThrow({ where: { id: tenantDead } });
  expect(row.status).toBe('PENDING');
  expect(row.attempts).toBe(0);
  expect((row.payload as Record<string, unknown>).box).toBe(`sealed-envelope-${RUN}`);
  const audit = await prisma.auditLog.findMany({ where: { targetId: tenantDead, action: 'MAIL_QUEUE_RETRY' } });
  expect(audit).toHaveLength(1);
  expect(audit[0].orgId).toBe(tenantOrgId);
  // Twice is a conflict on the state, never a second write.
  const again = await page.request.post(`/api/admin/mail-queue/${tenantDead}/retry`);
  expect(again.status()).toBe(409);
  expect((await again.json()).code).toBe('wrong_state');
  expect(await prisma.auditLog.count({ where: { targetId: tenantDead, action: 'MAIL_QUEUE_RETRY' } })).toBe(1);

  // Past its deadline: refused, untouched.
  const expired = await page.request.post(`/api/admin/mail-queue/${defaultDeadExpired}/retry`);
  expect(expired.status()).toBe(409);
  expect((await expired.json()).code).toBe('expired');
  expect((await prisma.job.findUniqueOrThrow({ where: { id: defaultDeadExpired } })).status).toBe('DEAD_LETTER');

  // Cancel: the waiting mail is withdrawn and its envelope cleared.
  const cancelled = await page.request.post(`/api/admin/mail-queue/${defaultPending}/cancel`);
  expect(cancelled.status()).toBe(200);
  const c = await prisma.job.findUniqueOrThrow({ where: { id: defaultPending } });
  expect(c.status).toBe('CANCELLED');
  expect((c.payload as Record<string, unknown>).box).toBeNull();
  expect(await prisma.auditLog.count({ where: { targetId: defaultPending, action: 'MAIL_QUEUE_CANCEL' } })).toBe(1);
  // A super admin of THIS world cannot reach the other world's row.
  expect((await page.request.post(`/api/admin/mail-queue/${marketingDead}/retry`)).status()).toBe(404);
});

test('retrying a dead newsletter copy re-opens its record and its tally', async ({ page }) => {
  // The drain settled this copy FAILED when it died: NewsletterSend FAILED and
  // the issue's tally moved from sent to failed. A retry puts the mail back on
  // the queue, so the record must say QUEUED again — or a delivery after the
  // retry could never settle it SENT (the settle only moves QUEUED records).
  const nl = await prisma.newsletter.create({
    data: {
      subject: `MQ newsletter ${RUN}`,
      content: {},
      status: 'SENT',
      sentAt: new Date(),
      createdById: superAdminId,
      orgId: tenantOrgId,
      recipientCount: 1,
      sentCount: 0,
      failedCount: 1,
    },
  });
  newsletterIds.push(nl.id);
  await prisma.newsletterSend.create({
    data: { newsletterId: nl.id, userId: superAdminId, email: superAdminEmail, locale: 'en', status: 'FAILED', error: 'smtp_550_5.1.1' },
  });
  const dead = await mkJob('nl-dead', { status: 'DEAD_LETTER', orgId: tenantOrgId, lane: 'BULK', priority: 0, ref: `nlsend:${nl.id}:${superAdminId}` });

  await signInAsFreshUser(page, superAdminEmail, PW, '/admin');
  const res = await page.request.post(`/api/admin/mail-queue/${dead.id}/retry`);
  expect(res.status()).toBe(200);
  const send = await prisma.newsletterSend.findFirstOrThrow({ where: { newsletterId: nl.id } });
  expect(send.status).toBe('QUEUED');
  expect(send.error).toBeNull();
  const tally = await prisma.newsletter.findUniqueOrThrow({ where: { id: nl.id }, select: { sentCount: true, failedCount: true } });
  expect(tally).toEqual({ sentCount: 1, failedCount: 0 });
  // The retried row's wait starts at the retry, not at its first enqueue.
  const row = await prisma.job.findUniqueOrThrow({ where: { id: dead.id } });
  expect(Date.now() - row.createdAt.getTime()).toBeLessThan(60_000);
});

test('the Queue tab lists the dead mail and retries it from the screen', async ({ page }) => {
  // A fresh dead row of its own, so this test does not depend on the one above.
  const dead = await mkJob('ui-dead', { status: 'DEAD_LETTER', orgId: tenantOrgId });
  await signInAsFreshUser(page, superAdminEmail, PW, '/admin');
  await gotoSettled(page, '/admin/settings');
  await page.getByTestId('mail-tab-queue').click();
  await expect(page.getByTestId('mail-queue-panel')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('mail-queue-breaker')).toBeVisible();
  const rowEl = page.getByTestId(`mail-queue-row-${dead.id}`);
  await expect(rowEl).toBeVisible();
  await expect(page.getByTestId('mail-queue-panel')).not.toContainText(SECRET_ADDRESS);
  await page.getByTestId(`mail-queue-retry-${dead.id}`).click();
  await expect(page.getByTestId('mail-queue-dead').getByTestId(`mail-queue-row-${dead.id}`)).toHaveCount(0);
  await expect(page.getByTestId('mail-queue-waiting').getByTestId(`mail-queue-row-${dead.id}`)).toBeVisible();
  expect((await prisma.job.findUniqueOrThrow({ where: { id: dead.id } })).status).toBe('PENDING');
});

test('the health endpoint carries a mail block for an operator: counts and ages, no addresses', async ({ request }) => {
  const res = await request.get('/api/health?jobs=1', { headers: { 'X-Health-Token': E2E_HEALTH_TOKEN } });
  expect(res.status()).toBe(200);
  const text = await res.text();
  const mail = JSON.parse(text).mail;
  expect(mail).toBeDefined();
  expect(Object.keys(mail.lanes).sort()).toEqual(['BULK', 'CRITICAL', 'TRANSACTIONAL']);
  for (const lane of Object.values(mail.lanes) as { pending: number; oldestPendingAgeSec: number | null }[]) {
    expect(typeof lane.pending).toBe('number');
    expect(lane.oldestPendingAgeSec === null || typeof lane.oldestPendingAgeSec === 'number').toBe(true);
  }
  for (const k of ['deferred24h', 'dead', 'failed24h', 'running']) expect(typeof mail[k]).toBe('number');
  expect(mail.dead).toBeGreaterThanOrEqual(1);
  expect(Object.keys(mail.breaker.primary).sort()).toEqual(['outageSec', 'pauseLevel', 'paused', 'pausedUntil']);
  expect(Object.keys(mail.day.primary).sort()).toEqual(['cap', 'count']);
  expect(text).not.toContain(SECRET_ADDRESS);
  expect(text).not.toContain('sealed-envelope');
  // Without ?jobs=1 the block costs nothing.
  const plain = await request.get('/api/health', { headers: { 'X-Health-Token': E2E_HEALTH_TOKEN } });
  expect((await plain.json()).mail).toBeUndefined();
});
