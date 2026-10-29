import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';
import { QUEUE_SCHEDULES } from '../src/lib/jobs/schedules';

// The operations console (#1607): who may read the deployment's job runs, and
// that the scope is the mail queue's operator rule — a super admin sees their
// world, the default organization's ADMIN only its own runs, every other caller
// is refused by the ROUTE (not by a hidden nav entry).
//
// Runs are seeded on one schedule's job with a marker in the error text per
// owner (another tenant / the default org / no org), so what leaks shows up in
// the body as a string.

const RUN = Date.now().toString(36);
const PW = 'OpsConsolePass123';
const JOB = 'auth.trustedDevicePurge';
const SCHEDULE_KEY = QUEUE_SCHEDULES.find((s) => s.job === JOB)!.key;
const MARK = { tenant: `opsmark-tenant-${RUN}`, own: `opsmark-default-${RUN}`, orgless: `opsmark-orgless-${RUN}` };

const superAdminEmail = uniqueEmail('ops-super');
const defaultAdminEmail = uniqueEmail('ops-default-admin');
const tenantAdminEmail = uniqueEmail('ops-tenant-admin');
const mentorEmail = uniqueEmail('ops-mentor');

let tenantOrgId = '';
const jobIds: string[] = [];
const startedAt = new Date();

async function seedRun(label: keyof typeof MARK, orgId: string | null, minutesAgo: number) {
  const when = new Date(Date.now() - minutesAgo * 60_000);
  const job = await prisma.job.create({
    data: {
      name: JOB,
      status: 'FAILED',
      payload: {},
      attempts: 1,
      idempotencyKey: `e2e-ops:${RUN}:${label}`,
      orgId,
      lastError: MARK[label],
      runs: { create: { attempt: 1, trigger: 'schedule', startedAt: when, finishedAt: when, ok: false, durationMs: 5, error: `${MARK[label]} boom` } },
    },
  });
  jobIds.push(job.id);
}

test.beforeAll(async () => {
  const def = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
  tenantOrgId = (await prisma.organization.create({ data: { name: `Ops Tenant ${RUN}`, slug: `ops-tenant-${RUN}` } })).id;
  const superAdmin = await seedUser(superAdminEmail, PW, 'ADMIN', 'Ops Super', def.id);
  await prisma.user.update({ where: { id: superAdmin.id }, data: { isSuperAdmin: true } });
  await seedUser(defaultAdminEmail, PW, 'ADMIN', 'Ops Default Admin', def.id);
  await seedUser(tenantAdminEmail, PW, 'ADMIN', 'Ops Tenant Admin', tenantOrgId);
  await seedUser(mentorEmail, PW, 'MENTOR', 'Ops Mentor', def.id);
  // Newest first for the super admin: the org-less platform run.
  await seedRun('tenant', tenantOrgId, 3);
  await seedRun('own', def.id, 2);
  await seedRun('orgless', null, 1);
});

test.afterAll(async () => {
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.job.deleteMany({ where: { name: 'jobs.deadLetterAlert', trigger: 'manual', createdAt: { gte: startedAt } } });
  for (const e of [superAdminEmail, defaultAdminEmail, tenantAdminEmail, mentorEmail]) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: tenantOrgId } }).catch(() => {});
  await prisma.$disconnect();
});

type View = {
  scope: string;
  schedules: { key: string; alarms: string[]; lastRun: { error: string | null } | null; rerunKey: string | null }[];
  errors: { failedRunsLastHour: number };
  leases?: unknown[];
};

async function view(page: Page) {
  const res = await page.request.get('/api/admin/operations');
  const text = await res.text();
  return { status: res.status(), text, body: res.ok() ? (JSON.parse(text) as View) : null };
}

test('the console refuses every non-operator at the route', { tag: '@smoke' }, async ({ page }) => {
  expect((await page.request.get('/api/admin/operations')).status()).toBe(401);

  await signInAsFreshUser(page, mentorEmail, PW, '/mentor');
  const mentor = await view(page);
  expect(mentor.status).toBe(403);
  expect(mentor.text).not.toContain('opsmark');

  // A tenant ADMIN is an ADMIN, and still not the deployment's operator.
  await signInAsFreshUser(page, tenantAdminEmail, PW, '/admin');
  const tenant = await view(page);
  expect(tenant.status).toBe(403);
  expect(JSON.parse(tenant.text).code).toBe('operations_operator_only');
  expect(tenant.text).not.toContain(MARK.tenant);
  await gotoSettled(page, '/admin/operations');
  await expect(page.getByTestId('operations-operator-only')).toBeVisible();
  await expect(page.getByTestId('operations-schedules')).toHaveCount(0);
  // …and the sidebar does not offer it.
  await expect(page.locator('aside a[href="/admin/operations"]')).toHaveCount(0);
});

test('the default org admin sees its own runs only; the super admin sees the world', { tag: '@smoke' }, async ({ page }) => {
  await signInAsFreshUser(page, defaultAdminEmail, PW, '/admin');
  const own = await view(page);
  expect(own.status).toBe(200);
  expect(own.body!.scope).toBe('organization');
  expect(own.body!.schedules).toHaveLength(QUEUE_SCHEDULES.length);
  expect(own.text).toContain(MARK.own);
  expect(own.text).not.toContain(MARK.tenant);
  expect(own.text).not.toContain(MARK.orgless);
  expect(own.body!.leases).toBeUndefined();
  // A platform job's re-run takes a super admin at /api/cron — not offered here.
  expect(own.body!.schedules.find((s) => s.key === 'jobs.deadLetterAlert')!.rerunKey).toBeNull();
  // The default org's ADMIN is an operator: the sidebar offers the console.
  await gotoSettled(page, '/admin');
  await expect(page.locator('aside a[href="/admin/operations"]').first()).toBeAttached();
  // The suite runs without ERROR_TRACKING_DSN: the card says so instead of linking.
  await gotoSettled(page, '/admin/operations');
  await expect(page.getByTestId('operations-tracker-off')).toBeVisible();
  await expect(page.getByTestId('operations-tracker-link')).toHaveCount(0);

  await signInAsFreshUser(page, superAdminEmail, PW, '/admin');
  const world = await view(page);
  expect(world.status).toBe(200);
  expect(world.body!.scope).toBe('world');
  const row = world.body!.schedules.find((s) => s.key === SCHEDULE_KEY)!;
  expect(row.lastRun!.error).toContain(MARK.orgless);
  expect(row.alarms).toContain('last_run_failed');
  expect(world.body!.errors.failedRunsLastHour).toBeGreaterThanOrEqual(3);

  await gotoSettled(page, '/admin/operations');
  await expect(page.getByTestId('operations-schedules').locator('tbody tr')).toHaveCount(QUEUE_SCHEDULES.length);
  await expect(page.getByTestId(`operations-schedule-${SCHEDULE_KEY}`)).toHaveAttribute('data-alarm', 'true');

  // Run now goes through /api/cron?job=…&enqueue=1 and queues a manual job.
  await page.getByTestId('operations-rerun-jobs.deadLetterAlert').click();
  await expect(page.getByTestId('operations-note')).toBeVisible();
  await expect
    .poll(() => prisma.job.count({ where: { name: 'jobs.deadLetterAlert', trigger: 'manual', createdAt: { gte: startedAt } } }))
    .toBeGreaterThan(0);
});
