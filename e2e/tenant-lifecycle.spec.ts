import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, apiSession } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

// Tenant lifecycle (#1580/#1582, docs/tenant-lifecycle.md): rename, slug
// collision, the SSO slug lock, archive → every door closed and no mail,
// unarchive → open again, and a tenant ADMIN refused all of it. Security
// boundaries, so @smoke.

const PASSWORD = 'Lifecycle123!';

async function seed() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const org = await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `lc-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `Acme Other ${stamp}`, slug: `lc-other-${stamp}` } });
  const emails = {
    operator: uniqueEmail('lc-operator'),
    admin: uniqueEmail('lc-admin'),
    mentee: uniqueEmail('lc-mentee'),
  };
  // The operator lives in the default world/org (orgId NULL), like the seeded admin.
  await seedUser(emails.operator, PASSWORD, 'ADMIN', 'LC Operator');
  await prisma.user.updateMany({ where: { email: emails.operator }, data: { isSuperAdmin: true } });
  await seedUser(emails.admin, PASSWORD, 'ADMIN', 'LC Tenant Admin', org.id);
  await seedUser(emails.mentee, PASSWORD, 'MENTEE', 'LC Mentee', org.id);
  await prisma.user.updateMany({ where: { email: { in: [emails.admin, emails.mentee] } }, data: { emailVerified: true, isActive: true } });
  return { org, other, emails, stamp };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function cleanup(s: Seeded) {
  for (const e of Object.values(s.emails)) await cleanupByEmail(e).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: [s.org.id, s.other.id] } } }).catch(() => {});
}

async function as(playwright: { request: { newContext: () => Promise<APIRequestContext> } }, email: string, ctxs: APIRequestContext[]) {
  const ctx = await playwright.request.newContext();
  ctxs.push(ctx);
  const r = await signInViaApi(ctx, email, PASSWORD, { headers: freshIp(`lc-${email}`) });
  expect(r.ok, `sign-in ${email}: ${r.error}`).toBe(true);
  return ctx;
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a super admin renames a tenant; a colliding slug is 409, an SSO tenant’s slug needs force, a tenant admin is refused', { tag: '@smoke' }, async ({ playwright }) => {
  const s = await seed();
  const ctxs: APIRequestContext[] = [];
  try {
    const op = await as(playwright, s.emails.operator, ctxs);
    const rename = (ctx: APIRequestContext, data: Record<string, unknown>) =>
      ctx.post(`/api/admin/organizations/${s.org.id}/rename`, { data });

    const ok = await rename(op, { name: `Acme Talent ${s.stamp}`, slug: `Acme Talent ${s.stamp}` });
    expect(ok.status()).toBe(200);
    const row = await prisma.organization.findUniqueOrThrow({ where: { id: s.org.id } });
    expect(row.name).toBe(`Acme Talent ${s.stamp}`);
    expect(row.slug).toBe(`acme-talent-${s.stamp}`);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: s.org.id, action: 'org.renamed' } });
    expect(audit?.detail).toContain(`slug: lc-${s.stamp} → acme-talent-${s.stamp}`);

    const clash = await rename(op, { slug: s.other.slug });
    expect(clash.status()).toBe(409);
    expect((await clash.json()).code).toBe('slug_taken');

    await prisma.organization.update({ where: { id: s.org.id }, data: { ssoEnabled: true } });
    const locked = await rename(op, { slug: `lc-sso-${s.stamp}` });
    expect(locked.status()).toBe(409);
    expect((await locked.json()).code).toBe('sso_slug_locked');
    const forced = await rename(op, { slug: `lc-sso-${s.stamp}`, force: true });
    expect(forced.status()).toBe(200);
    expect((await prisma.auditLog.findFirst({ where: { orgId: s.org.id, action: 'org.renamed', detail: { contains: 'FORCED' } } }))).not.toBeNull();

    // The default org's slug never moves.
    const def = await prisma.organization.findUnique({ where: { slug: 'default' } });
    if (def) {
      const res = await op.post(`/api/admin/organizations/${def.id}/rename`, { data: { slug: `not-default-${s.stamp}` } });
      expect(res.status()).toBe(409);
      expect((await res.json()).code).toBe('default_org_slug');
    }

    // A tenant ADMIN — even of this very org — holds no platform permission.
    const admin = await as(playwright, s.emails.admin, ctxs);
    const refused = await rename(admin, { name: 'Hijacked' });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('permission_denied');
    expect((await admin.post(`/api/admin/organizations/${s.org.id}/archive`)).status()).toBe(403);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: s.org.id } })).archivedAt).toBeNull();
  } finally {
    for (const c of ctxs) await c.dispose();
    await cleanup(s);
  }
});

test('archiving closes every door with a wrong-password answer and stops mail; unarchiving reopens', { tag: '@smoke' }, async ({ playwright, request }) => {
  const s = await seed();
  const ctxs: APIRequestContext[] = [];
  try {
    const op = await as(playwright, s.emails.operator, ctxs);
    // A live session of the tenant, taken before the archive.
    const mentee = await as(playwright, s.emails.mentee, ctxs);
    expect(await apiSession(mentee)).not.toBeNull();

    const archived = await op.post(`/api/admin/organizations/${s.org.id}/archive`);
    expect(archived.status()).toBe(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: s.org.id } })).archivedAt).not.toBeNull();
    expect(await prisma.auditLog.findFirst({ where: { orgId: s.org.id, action: 'org.archived' } })).not.toBeNull();
    // Twice is a conflict, not a second row.
    expect((await op.post(`/api/admin/organizations/${s.org.id}/archive`)).status()).toBe(409);

    // The live session ends on its next request.
    expect(await apiSession(mentee)).toBeNull();

    // The right password is refused with exactly the wrong-password words.
    const fresh = await playwright.request.newContext();
    ctxs.push(fresh);
    const right = await signInViaApi(fresh, s.emails.mentee, PASSWORD, { headers: freshIp(`lc-right-${s.stamp}`) });
    const wrong = await signInViaApi(fresh, s.emails.mentee, 'Not-The-Password1!', { headers: freshIp(`lc-wrong-${s.stamp}`) });
    expect(right.ok).toBe(false);
    expect(right.error).toBe(wrong.error);

    // No mail reaches the tenant's people — a reset included.
    const forgot = await request.post('/api/auth/forgot', { data: { email: s.emails.mentee }, headers: freshIp(`lc-forgot-${s.stamp}`) });
    expect(forgot.status()).toBe(200);
    await expect
      .poll(async () => (await prisma.emailLog.findFirst({ where: { to: s.emails.mentee }, orderBy: { createdAt: 'desc' } }))?.error ?? null, { timeout: 10_000 })
      .toBe('Tenant archived');

    // Nothing was destroyed, and it comes back.
    expect(await prisma.user.count({ where: { orgId: s.org.id } })).toBe(2);
    const back = await op.delete(`/api/admin/organizations/${s.org.id}/archive`);
    expect(back.status()).toBe(200);
    const again = await playwright.request.newContext();
    ctxs.push(again);
    expect((await signInViaApi(again, s.emails.mentee, PASSWORD, { headers: freshIp(`lc-again-${s.stamp}`) })).ok).toBe(true);
    expect(await prisma.auditLog.findFirst({ where: { orgId: s.org.id, action: 'org.unarchived' } })).not.toBeNull();
  } finally {
    for (const c of ctxs) await c.dispose();
    await cleanup(s);
  }
});

test('the operator cannot archive the default organization', { tag: '@smoke' }, async ({ playwright }) => {
  const s = await seed();
  const ctxs: APIRequestContext[] = [];
  try {
    const def = await prisma.organization.findUnique({ where: { slug: 'default' } });
    test.skip(!def, 'no default organization in this database');
    const op = await as(playwright, s.emails.operator, ctxs);
    const res = await op.post(`/api/admin/organizations/${def!.id}/archive`);
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('default_org');
  } finally {
    for (const c of ctxs) await c.dispose();
    await cleanup(s);
  }
});
