import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Every organization write leaves an audit trail in the TARGET organization
// (#1575, src/lib/orgAudit.ts): an AuditLog row its audit drain receives, and
// an ActivityLog entry stamped with its orgId — never the actor's. Before,
// a super admin configuring tenant B filed the entry under its own home org,
// and creating a tenant put the customer's name and first admin's address in
// the operator org's activity feed.

const PASSWORD = 'OrgAuditPass123!';
const emails: string[] = [];
const orgIds: string[] = [];

function stamp() {
  return `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

async function seedOperator(label: string) {
  const email = uniqueEmail(`org-audit-${label}`);
  emails.push(email);
  const home = await prisma.organization.create({
    data: { name: `Audit Ops ${label}`, slug: `audit-ops-${label}-${stamp()}` },
  });
  orgIds.push(home.id);
  const user = await seedUser(email, PASSWORD, 'ADMIN', 'Org Audit Operator', home.id);
  await prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
  return { email, user, home };
}

async function seedTenant(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Audit Tenant ${label}`, slug: `audit-tenant-${label}-${stamp()}`, plan: 'ENTERPRISE' },
  });
  orgIds.push(org.id);
  return org;
}

// The operator's own activity feed, as any admin of its home org reads it.
async function feedText(page: Page, action: string): Promise<string> {
  const res = await page.request.get(`/api/admin/activity?action=${encodeURIComponent(action)}`);
  expect(res.status()).toBe(200);
  return JSON.stringify((await res.json()).items);
}

test.afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.invitationToken.deleteMany({ where: { orgId: { in: orgIds } } });
  for (const email of emails) await cleanupByEmail(email);
  await prisma.user.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

test(
  "creating a tenant files its name and first admin's address under the NEW org, not the operator's",
  { tag: '@smoke' },
  async ({ page }) => {
    const { email, user, home } = await seedOperator('create');
    const s = stamp();
    const name = `Acme Audit ${s}`;
    const invitee = uniqueEmail('org-audit-first-admin');
    emails.push(invitee);

    await signInAndSettle(page, email, PASSWORD, '/admin');
    const res = await page.request.post('/api/admin/organizations', {
      data: { name, slug: `acme-audit-${s}`, vertical: 'INTERNSHIP', firstAdminEmail: invitee },
    });
    expect(res.status()).toBe(201);
    const created = await res.json();
    const orgId: string = created.organization.id;
    orgIds.push(orgId);

    // The audit drain of the new tenant receives its creation and the invitation.
    const audit = await prisma.auditLog.findMany({ where: { actorId: user.id, orgId } });
    expect(audit.map((r) => r.action).sort()).toEqual(['invite.created', 'org.created', 'organization.admin_invited']);
    // The AuditLog copy of the invitation names the channel, never the address.
    expect(JSON.stringify(audit)).not.toContain(invitee);

    // Every activity entry of this act is the new tenant's.
    const activity = await prisma.activityLog.findMany({
      where: { actorId: user.id, action: { in: ['org.created', 'invite.created', 'organization.admin_invited'] } },
    });
    expect(activity).toHaveLength(3);
    for (const row of activity) expect(row.orgId).toBe(orgId);
    expect(
      await prisma.activityLog.count({
        where: { actorId: user.id, orgId: home.id, action: { in: ['org.created', 'invite.created', 'organization.admin_invited'] } },
      })
    ).toBe(0);

    // …so the operator org's own feed shows neither the customer nor the address.
    for (const action of ['org.created', 'invite.created', 'organization.admin_invited']) {
      const text = await feedText(page, action);
      expect(text).not.toContain(name);
      expect(text).not.toContain(invitee);
      expect(text).not.toContain(orgId);
    }
  }
);

test("a super admin's writes to another tenant land in that tenant's audit trail", async ({ page }) => {
  const { email, user, home } = await seedOperator('writes');
  const tenant = await seedTenant('writes');

  await signInAndSettle(page, email, PASSWORD, '/admin');

  const patch = await page.request.patch('/api/admin/organizations', {
    data: { id: tenant.id, brandColor: '#123456' },
  });
  expect(patch.status()).toBe(200);

  const stages = await page.request.put(`/api/admin/organizations/${tenant.id}/pipeline-stages`, {
    data: {
      stages: [
        { key: 'APPLICATION_100', label: 'Applied', order: 0 },
        { key: 'HIRED_660', label: 'Hired', order: 1, isTerminal: true },
      ],
    },
  });
  expect(stages.status()).toBe(200);
  const reset = await page.request.delete(`/api/admin/organizations/${tenant.id}/pipeline-stages`);
  expect(reset.status()).toBe(200);

  const conferencing = await page.request.patch(`/api/admin/organizations/${tenant.id}/conferencing`, {
    data: { policy: 'PREFER_PERSONAL' },
  });
  expect(conferencing.status()).toBe(200);

  const expected = ['org.updated', 'org.pipeline_stages_replaced', 'org.pipeline_stages_reset', 'organization.conferencing_policy'];

  const audit = await prisma.auditLog.findMany({ where: { actorId: user.id }, orderBy: { createdAt: 'asc' } });
  expect(audit.map((r) => r.action)).toEqual(expected);
  for (const row of audit) {
    expect(row.orgId).toBe(tenant.id);
    expect(row.targetId).toBe(tenant.id);
  }
  // Which fields changed, never their values.
  expect(audit[0].detail).toBe('brandColor');

  const activity = await prisma.activityLog.findMany({ where: { actorId: user.id, action: { in: expected } } });
  expect(activity).toHaveLength(expected.length);
  for (const row of activity) {
    expect(row.orgId).toBe(tenant.id);
    expect(row.targetType).toBe('organization');
    expect(row.targetId).toBe(tenant.id);
  }
  expect(await prisma.activityLog.count({ where: { actorId: user.id, orgId: home.id, action: { in: expected } } })).toBe(0);

  for (const action of expected) expect(await feedText(page, action)).not.toContain(tenant.id);
});
