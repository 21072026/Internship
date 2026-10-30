import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { seedTwoTenants, TENANT_PASSWORD, type TwoTenants } from './helpers/tenants';

// The tenant offboarding export (#1584, docs/tenant-lifecycle.md § Export):
// complete for the tenant, nothing of the other tenant, no credential, and
// reachable only by the world's super admin or the tenant's own ORG_ADMIN.
// Security boundary → @smoke.

let tenants: TwoTenants;
const operatorEmail = uniqueEmail('export-operator');
const extra: { interactionId?: string; messageId?: string } = {};

test.beforeAll(async () => {
  tenants = await seedTwoTenants();
  await seedUser(operatorEmail, TENANT_PASSWORD, 'ADMIN', 'Export Operator');
  await prisma.user.updateMany({ where: { email: operatorEmail }, data: { isSuperAdmin: true } });
  const a = tenants.orgA;
  extra.interactionId = (
    await prisma.interactionLog.create({
      data: { relationId: a.relation.id, date: new Date(), type: 'Meeting', notes: 'Export check: first call went well' },
    })
  ).id;
  extra.messageId = (
    await prisma.message.create({ data: { relationId: a.relation.id, senderId: a.mentor.id, body: 'Export check: hello' } })
  ).id;
});

test.afterAll(async () => {
  if (extra.messageId) await prisma.message.deleteMany({ where: { id: extra.messageId } }).catch(() => {});
  if (extra.interactionId) await prisma.interactionLog.deleteMany({ where: { id: extra.interactionId } }).catch(() => {});
  await cleanupByEmail(operatorEmail).catch(() => {});
  await tenants?.cleanup();
  await prisma.$disconnect();
});

async function signedIn(playwright: { request: { newContext: () => Promise<APIRequestContext> } }, email: string, ctxs: APIRequestContext[]) {
  const ctx = await playwright.request.newContext();
  ctxs.push(ctx);
  const r = await signInViaApi(ctx, email, TENANT_PASSWORD, { headers: freshIp(`export-${email}`) });
  expect(r.ok, `sign-in ${email}: ${r.error}`).toBe(true);
  return ctx;
}

test('the export holds the whole tenant, nothing of the other one, and no credential', { tag: '@smoke' }, async ({ playwright }) => {
  const ctxs: APIRequestContext[] = [];
  try {
    const op = await signedIn(playwright, operatorEmail, ctxs);
    const a = tenants.orgA;
    const b = tenants.orgB;
    const res = await op.get(`/api/admin/organizations/${a.org.id}/export`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toContain(`tenant-export-${a.org.slug}`);
    const text = await res.text();
    const doc = JSON.parse(text);

    expect(doc._meta.format).toBe('interncrm.tenant-export/1');
    expect(doc.organization.id).toBe(a.org.id);
    for (const k of ['User.password', 'User.twoFactorSecret', 'ApiKey.hashedKey', 'Webhook.secret', 'Organization.ssoCertificate']) {
      expect(doc._meta.omittedFields[k], k).toBeTruthy();
    }

    const ids = (model: string) => new Set((doc.collections[model] ?? []).map((r: { id: string }) => r.id));
    for (const actor of a.actors) expect(ids('User').has(actor.id), actor.email).toBe(true);
    expect(ids('MentorshipRelation').has(a.relation.id)).toBe(true);
    expect(ids('Company').has(a.company.id)).toBe(true);
    expect(ids('Offer').has(a.offer.id)).toBe(true);
    expect(ids('InteractionLog').has(extra.interactionId)).toBe(true);
    expect(ids('Message').has(extra.messageId)).toBe(true);
    expect(doc._summary.User).toBe(doc.collections.User.length);

    // Not one row of tenant B — by id anywhere in the file.
    for (const id of [b.org.id, b.relation.id, b.company.id, b.offer.id, ...b.actors.map((x) => x.id)]) {
      expect(text.includes(id), `tenant B id ${id} leaked`).toBe(false);
    }
    // No credential column anywhere.
    for (const u of doc.collections.User) {
      expect(u).not.toHaveProperty('password');
      expect(u).not.toHaveProperty('twoFactorSecret');
    }
    expect(doc.organization).not.toHaveProperty('ssoCertificate');
    expect(doc.organization).not.toHaveProperty('ssoSpKey');
    expect(text).not.toMatch(/\$2[aby]\$\d{2}\$/); // no bcrypt hash, under any key

    const audit = await prisma.auditLog.findFirst({ where: { orgId: a.org.id, action: 'org.exported' } });
    expect(audit).not.toBeNull();
  } finally {
    for (const c of ctxs) await c.dispose();
  }
});

test('a tenant’s own admin exports its org; another tenant’s admin and a mentor are refused', { tag: '@smoke' }, async ({ playwright }) => {
  const ctxs: APIRequestContext[] = [];
  try {
    const a = tenants.orgA;
    const b = tenants.orgB;
    const adminA = await signedIn(playwright, a.admin.email, ctxs);
    const own = await adminA.get(`/api/admin/organizations/${a.org.id}/export`);
    expect(own.status()).toBe(200);
    expect(JSON.parse(await own.text()).organization.id).toBe(a.org.id);

    const foreign = await adminA.get(`/api/admin/organizations/${b.org.id}/export`);
    expect(foreign.status()).toBe(403);
    expect((await foreign.json()).code).toBe('permission_denied');

    const mentorA = await signedIn(playwright, a.mentor.email, ctxs);
    expect((await mentorA.get(`/api/admin/organizations/${a.org.id}/export`)).status()).toBe(403);
  } finally {
    for (const c of ctxs) await c.dispose();
  }
});
