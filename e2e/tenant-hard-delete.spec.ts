import { test, expect, type APIRequestContext } from '@playwright/test';
import { Prisma } from '@prisma/client';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { seedTwoTenants, remainingTenantRows, TENANT_PASSWORD, type TwoTenants } from './helpers/tenants';
import { deleteTenantRows, deletionPlan, viaStepsWithoutId } from '@/lib/orgDeletionExec';

// Tenant hard delete (#1584, docs/tenant-lifecycle.md § Hard delete).
//
// Two halves, both @smoke (an irreversible operation is a boundary):
//   1. over HTTP, against a server whose TENANT_HARD_DELETE_ENABLED is unset —
//      which is every CI and topic environment — every door refuses, and a
//      tenant ADMIN is refused before the switch is even read;
//   2. the EXECUTOR itself, run in this worker against the test database on a
//      synthetic tenant: it removes every row of tenant A — the child rows
//      that carry no orgId included — and not one row of tenant B.

let tenants: TwoTenants;
const operatorEmail = uniqueEmail('hard-delete-operator');
const extra: { interactionId?: string; messageId?: string } = {};

test.beforeAll(async () => {
  tenants = await seedTwoTenants();
  await seedUser(operatorEmail, TENANT_PASSWORD, 'ADMIN', 'Hard Delete Operator');
  await prisma.user.updateMany({ where: { email: operatorEmail }, data: { isSuperAdmin: true } });
  const a = tenants.orgA;
  extra.interactionId = (
    await prisma.interactionLog.create({ data: { relationId: a.relation.id, date: new Date(), type: 'Meeting', notes: 'hard delete check' } })
  ).id;
  extra.messageId = (await prisma.message.create({ data: { relationId: a.relation.id, senderId: a.mentor.id, body: 'hard delete check' } })).id;
});

test.afterAll(async () => {
  await prisma.message.deleteMany({ where: { id: extra.messageId } }).catch(() => {});
  await prisma.interactionLog.deleteMany({ where: { id: extra.interactionId } }).catch(() => {});
  await cleanupByEmail(operatorEmail).catch(() => {});
  await tenants?.cleanup().catch(() => {});
  await prisma.$disconnect();
});

async function signedIn(playwright: { request: { newContext: () => Promise<APIRequestContext> } }, email: string, ctxs: APIRequestContext[]) {
  const ctx = await playwright.request.newContext();
  ctxs.push(ctx);
  const r = await signInViaApi(ctx, email, TENANT_PASSWORD, { headers: freshIp(`hd-${email}`) });
  expect(r.ok, `sign-in ${email}: ${r.error}`).toBe(true);
  return ctx;
}

test('with the switch off every deletion door refuses; a tenant admin is refused outright', { tag: '@smoke' }, async ({ playwright }) => {
  const ctxs: APIRequestContext[] = [];
  const a = tenants.orgA;
  try {
    await prisma.organization.update({ where: { id: a.org.id }, data: { archivedAt: new Date() } });
    const op = await signedIn(playwright, operatorEmail, ctxs);

    const req = await op.post(`/api/admin/organizations/${a.org.id}/deletion`, { data: { confirmSlug: a.org.slug } });
    expect(req.status()).toBe(403);
    expect((await req.json()).code).toBe('hard_delete_disabled');
    const run = await op.delete(`/api/admin/organizations/${a.org.id}`, { data: { confirmSlug: a.org.slug, password: TENANT_PASSWORD } });
    expect(run.status()).toBe(403);
    expect((await run.json()).code).toBe('hard_delete_disabled');
    const cancel = await op.delete(`/api/admin/organizations/${a.org.id}/deletion`);
    expect(cancel.status()).toBe(403);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: a.org.id } })).deletionRequestedAt).toBeNull();

    // The list tells the operator's screen the switch is off.
    expect((await (await op.get('/api/admin/organizations')).json()).hardDelete.enabled).toBe(false);

    const admin = await signedIn(playwright, tenants.orgB.admin.email, ctxs);
    for (const res of [
      await admin.post(`/api/admin/organizations/${a.org.id}/deletion`, { data: { confirmSlug: a.org.slug } }),
      await admin.delete(`/api/admin/organizations/${a.org.id}`, { data: { confirmSlug: a.org.slug, password: TENANT_PASSWORD } }),
    ]) {
      expect(res.status()).toBe(403);
      expect((await res.json()).code).toBe('permission_denied');
    }
    expect(await prisma.organization.count({ where: { id: a.org.id } })).toBe(1);
  } finally {
    await prisma.organization.update({ where: { id: a.org.id }, data: { archivedAt: null } }).catch(() => {});
    for (const c of ctxs) await c.dispose();
  }
});

test('the executor removes every row of one tenant and none of the other', { tag: '@smoke' }, async () => {
  const a = tenants.orgA;
  const b = tenants.orgB;
  expect(viaStepsWithoutId(deletionPlan())).toEqual([]);
  const before = await remainingTenantRows([b.org.id]);

  const result = await deleteTenantRows(prisma, a.org.id);
  expect(result.deleted.Organization).toBe(1);
  expect(result.deleted.User).toBe(a.actors.length);

  const left = await remainingTenantRows([a.org.id]);
  for (const [model, n] of Object.entries(left)) expect(n, `${model} rows of the deleted tenant`).toBe(0);
  // Children without an orgId went with their parents.
  expect(await prisma.interactionLog.count({ where: { id: extra.interactionId } })).toBe(0);
  expect(await prisma.message.count({ where: { id: extra.messageId } })).toBe(0);
  // Every orgId model, not only the fixture's: nothing references the org.
  for (const m of Prisma.dmmf.datamodel.models) {
    if (m.name === 'Organization' || !m.fields.some((f) => f.name === 'orgId' && f.kind === 'scalar')) continue;
    const key = m.name.charAt(0).toLowerCase() + m.name.slice(1);
    const n = await (prisma as unknown as Record<string, { count: (a: unknown) => Promise<number> }>)[key].count({ where: { orgId: a.org.id } });
    expect(n, `${m.name} still references the deleted org`).toBe(0);
  }

  expect(await remainingTenantRows([b.org.id])).toEqual(before);
});
