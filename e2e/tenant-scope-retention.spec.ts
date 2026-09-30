import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled } from './helpers/auth';
import { seedTwoTenants, signInAsTenantActor, TENANT_PASSWORD, type TwoTenants } from './helpers/tenants';

/**
 * The data-retention surfaces stay inside the admin's own tenant (#2542) — with
 * MT_ENFORCE_ISOLATION **off**, as in every deployment today.
 *
 * Before the fix, on one database holding two tenants:
 *   - `/admin/retention` listed every tenant's candidates past the consent
 *     limit, by name and e-mail address;
 *   - `GET /api/admin/orphan-applicants` (the panel on the same page) listed
 *     every tenant's never-activated applicants, with an erase control per row.
 * The reminder job's admin summary (`retention.adminSummary`) is asserted here
 * too: each org's admins get THEIR org's count, and an org-less candidate is
 * counted for the default org, not for anyone else.
 *
 * Every exclusion has its positive twin, or a page that listed nothing would
 * pass it.
 */

let tenants: TwoTenants;
// Rows this spec adds on top of the fixture. Org-bound ones go with
// `tenants.cleanup()`; the org-less one is removed by id.
let orphanA: { id: string; fullName: string };
let orphanB: { id: string; fullName: string };
let extraDueA: { id: string };
let orglessDue: { id: string } | null = null;

const EIGHTEEN_MONTHS_AGO = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 18);
  return d;
};

// An account exactly as /apply leaves it and a mentor's decline keeps it: the
// sentinel password, never verified, never signed in, nothing attached.
async function seedOrphan(orgId: string, label: string) {
  return prisma.user.create({
    data: {
      email: uniqueEmail(`retention-orphan-${label}`),
      password: '!apply-no-login',
      // The column defaults to true; /apply writes false.
      emailVerified: false,
      role: 'MENTEE',
      fullName: `ZZ Retention Orphan ${label} ${Date.now()}`,
      skills: [],
      orgId,
    },
    select: { id: true, fullName: true },
  });
}

test.beforeAll(async () => {
  tenants = await seedTwoTenants();
  const { orgA, orgB } = tenants;
  // Both fixture mentees are past the (default 12-month) consent limit, and
  // org A holds a second one, so the per-org counts differ (A = 2, B = 1).
  await prisma.user.updateMany({
    where: { id: { in: [orgA.mentee.id, orgB.mentee.id] } },
    data: { consentAt: EIGHTEEN_MONTHS_AGO(), retentionReminderSentAt: null },
  });
  extraDueA = await seedUser(uniqueEmail('retention-due-a'), TENANT_PASSWORD, 'MENTEE', 'ZZ Retention Due A2', orgA.org.id);
  await prisma.user.update({ where: { id: extraDueA.id }, data: { consentAt: EIGHTEEN_MONTHS_AGO() } });

  orphanA = await seedOrphan(orgA.org.id, 'A');
  orphanB = await seedOrphan(orgB.org.id, 'B');
});

test.afterAll(async () => {
  if (orglessDue) await prisma.user.deleteMany({ where: { id: orglessDue.id } });
  await tenants?.cleanup();
  await prisma.$disconnect();
});

for (const [label, pick] of [
  ['A reads B', (t: TwoTenants) => [t.orgA, t.orgB] as const],
  ['B reads A', (t: TwoTenants) => [t.orgB, t.orgA] as const],
] as const) {
  test(`the retention review lists only the admin's own candidates · ${label}`, { tag: '@smoke' }, async ({ page }) => {
    const [own, other] = pick(tenants);
    await signInAsTenantActor(page, own.admin);
    await gotoSettled(page, '/admin/retention');

    const table = page.locator('table');
    await expect(table.getByText(own.mentee.email, { exact: true })).toBeVisible();
    await expect(table.getByText(other.mentee.email, { exact: true })).toHaveCount(0);
    await expect(page.locator(`a[href="/admin/candidates/${other.mentee.id}"]`)).toHaveCount(0);
  });

  test(`the orphan-applicant dry run lists only the admin's own org · ${label}`, async ({ page }) => {
    const [own] = pick(tenants);
    const [ownOrphan, otherOrphan] = own === tenants.orgA ? [orphanA, orphanB] : [orphanB, orphanA];
    await signInAsTenantActor(page, own.admin);

    const res = await page.request.get('/api/admin/orphan-applicants');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { total: number; items: { id: string }[] };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(ownOrphan.id);
    expect(ids, "another tenant's orphan applicant leaked").not.toContain(otherOrphan.id);
    // The count is scoped by the same filter as the list: this org holds
    // exactly one orphan, and the default org's backlog is not added to it.
    expect(body.total).toBe(1);
  });
}

test("the reminder job tells each org's admins their own org's count", async ({ page }) => {
  const { orgA, orgB } = tenants;
  // An org-less candidate belongs to the DEFAULT org: it must not be counted
  // for A or B.
  orglessDue = await seedUser(uniqueEmail('retention-due-orgless'), TENANT_PASSWORD, 'MENTEE', 'ZZ Retention Orgless');
  await prisma.user.update({ where: { id: orglessDue.id }, data: { consentAt: EIGHTEEN_MONTHS_AGO() } });
  await prisma.notification.deleteMany({
    where: { userId: { in: [orgA.admin.id, orgB.admin.id] }, type: 'retention.adminSummary' },
  });

  await signInAsTenantActor(page, orgA.admin);
  // The job sweeps every tenant's due candidates, not only this spec's, so a
  // database other specs have filled can take a while.
  const res = await page.request.get('/api/cron?job=retention', { timeout: 90_000 });
  expect(res.status()).toBe(200);

  const summaries = await prisma.notification.findMany({
    where: { userId: { in: [orgA.admin.id, orgB.admin.id] }, type: 'retention.adminSummary' },
    select: { userId: true, params: true },
  });
  const countFor = (userId: string) =>
    summaries.filter((s) => s.userId === userId).map((s) => (s.params as { count?: number } | null)?.count);
  expect(countFor(orgA.admin.id)).toEqual([2]);
  expect(countFor(orgB.admin.id)).toEqual([1]);

  // Every due candidate of both orgs was actually reminded (the positive half).
  const stamped = await prisma.user.count({
    where: { id: { in: [orgA.mentee.id, extraDueA.id, orgB.mentee.id] }, retentionReminderSentAt: { not: null } },
  });
  expect(stamped).toBe(3);
});
