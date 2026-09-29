import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';
import { seedTwoTenants, signInAsTenantActor, putOnWorld, type SeededTenant, type TwoTenants } from './helpers/tenants';

/**
 * A MARKETING admin must not read the INTERNSHIP tenant's people or companies,
 * and the other way round (#2542) — with MT_ENFORCE_ISOLATION **off**.
 *
 * Measured before the fix, on one database holding both products: a SaleVali
 * (MARKETING) admin's `GET /api/users?role=MENTEE` and `GET /api/companies`
 * returned the INTERNSHIP tenant's rows, and `GET /api/users/<id>` opened one
 * of its mentees. The central tenant middleware would have scoped all three,
 * but it only engages with the flag on, and the flag is off in every
 * deployment (docs/tenant-isolation.md § Rollout; flipping it is #1572).
 *
 * So this spec runs on the DEFAULT project, whose server has no
 * MT_ENFORCE_ISOLATION — the point is that the routes scope themselves. The
 * `isolation` project (e2e/isolation/**) is the flag-on half; a filter written
 * by hand there reads the same `resolveOrgId(session)` the middleware injects,
 * so the two halves cannot disagree.
 *
 * Every exclusion has its positive twin (the caller's OWN row comes back), or
 * a route that returned nothing at all would pass it.
 */

let tenants: TwoTenants;

test.beforeAll(async () => {
  tenants = await seedTwoTenants({ verticalA: 'INTERNSHIP', verticalB: 'MARKETING' });
});

test.afterAll(async () => {
  await tenants?.cleanup();
});

async function ids(page: Page, path: string, key: string): Promise<string[]> {
  const res = await page.request.get(path);
  expect(res.status(), `${path} should answer 200`).toBe(200);
  const rows = (await res.json())[key] as { id: string }[] | undefined;
  expect(Array.isArray(rows), `${path} should return ${key}[]`).toBe(true);
  return (rows ?? []).map((r) => r.id);
}

/** Both directions: A (INTERNSHIP) reading B (MARKETING), and B reading A. */
const DIRECTIONS: Array<[string, (t: TwoTenants) => [SeededTenant, SeededTenant]]> = [
  ['INTERNSHIP admin → MARKETING tenant', (t) => [t.orgA, t.orgB]],
  ['MARKETING admin → INTERNSHIP tenant', (t) => [t.orgB, t.orgA]],
];

for (const [label, pick] of DIRECTIONS) {
  test(`lists exclude the other tenant · ${label}`, { tag: '@smoke' }, async ({ page }) => {
    const [own, other] = pick(tenants);
    expect(own.org.vertical).not.toBe(other.org.vertical);
    await signInAsTenantActor(page, own.admin);

    const foreignPeople = other.actors.map((a) => a.id);
    for (const path of [
      '/api/users?role=MENTEE',
      '/api/users',
      '/api/users?view=directory',
      '/api/users?view=picker',
      '/api/users?view=mentorAvailability&role=MENTOR',
      '/api/users?page=1&perPage=100',
    ]) {
      const got = await ids(page, path, 'users');
      for (const id of foreignPeople) {
        expect(got, `${path} leaked another tenant's user`).not.toContain(id);
      }
    }
    // The positive half: the admin's own mentee and mentor are still there.
    expect(await ids(page, '/api/users?role=MENTEE', 'users')).toContain(own.mentee.id);
    expect(await ids(page, '/api/users?view=mentorAvailability&role=MENTOR', 'users')).toContain(own.mentor.id);

    const candidates = await ids(page, '/api/candidates?all=1', 'candidates');
    expect(candidates, '/api/candidates leaked another tenant\'s mentee').not.toContain(other.mentee.id);
    expect(candidates).toContain(own.mentee.id);

    const companies = await ids(page, '/api/companies?all=1', 'companies');
    expect(companies, '/api/companies leaked another tenant\'s company').not.toContain(other.company.id);
    expect(companies).toContain(own.company.id);
    // The derived sort builds its own queries (#2528); it must scope too.
    const byMovement = await ids(page, '/api/companies?all=1&sort=movement', 'companies');
    expect(byMovement).not.toContain(other.company.id);
    expect(byMovement).toContain(own.company.id);
  });

  test(`reads by id answer 404 across tenants · ${label}`, async ({ page }) => {
    const [own, other] = pick(tenants);
    await signInAsTenantActor(page, own.admin);

    // Own rows: 200, and the row really is the one asked for.
    const ownUser = await page.request.get(`/api/users/${own.mentee.id}`);
    expect(ownUser.status()).toBe(200);
    expect((await ownUser.json()).user.id).toBe(own.mentee.id);
    const ownCompany = await page.request.get(`/api/companies/${own.company.id}`);
    expect(ownCompany.status()).toBe(200);
    expect((await ownCompany.json()).company.id).toBe(own.company.id);
    const ownImpact = await page.request.get(`/api/companies/${own.company.id}/delete-impact`);
    expect(ownImpact.status()).toBe(200);
    expect((await ownImpact.json()).impact.name).toBe(own.company.name);

    // Foreign rows: 404 — the same answer as an id that does not exist, so
    // the route confirms nothing about the other tenant.
    for (const path of [
      `/api/users/${other.mentee.id}`,
      `/api/users/${other.admin.id}`,
      `/api/users/${other.mentee.id}/activity`,
      `/api/companies/${other.company.id}`,
      // The delete dialog's preview (#2441) runs before the DELETE and would
      // otherwise confirm the id and disclose the name and cascade counts.
      `/api/companies/${other.company.id}/delete-impact`,
    ]) {
      const res = await page.request.get(path);
      expect(res.status(), `${path} must be a 404 for another tenant's admin`).toBe(404);
      expect(await res.text(), `${path} must not echo the foreign row`).not.toContain(other.mentee.email);
    }
  });

  test(`writes by id answer 404 and change nothing across tenants · ${label}`, async ({ page }) => {
    const [own, other] = pick(tenants);
    await signInAsTenantActor(page, own.admin);

    const deactivate = await page.request.patch(`/api/users/${other.mentee.id}`, { data: { isActive: false } });
    expect(deactivate.status()).toBe(404);
    const convert = await page.request.patch(`/api/users/${other.mentee.id}`, { data: { role: 'MENTOR' } });
    expect(convert.status()).toBe(404);

    const rename = await page.request.put(`/api/companies/${other.company.id}`, { data: { name: 'renamed across tenants' } });
    expect(rename.status()).toBe(404);
    const remove = await page.request.delete(`/api/companies/${other.company.id}`);
    expect(remove.status()).toBe(404);

    for (const path of [
      `/api/admin/users/${other.mentee.id}/sign-out-all`,
      `/api/admin/users/${other.mentee.id}/reset-password`,
      `/api/users/${other.mentee.id}/resend-verification`,
    ]) {
      const res = await page.request.post(path);
      expect(res.status(), `POST ${path} must be a 404 for another tenant's admin`).toBe(404);
    }
    const unlock = await page.request.delete(`/api/admin/users/${other.mentee.id}/lockout`);
    expect(unlock.status()).toBe(404);

    // Asked of the database, not of the responses: a 404 that still wrote
    // would pass every assertion above.
    const mentee = await prisma.user.findUniqueOrThrow({
      where: { id: other.mentee.id },
      select: { isActive: true, role: true, sessionsValidFrom: true },
    });
    expect(mentee).toEqual({ isActive: true, role: 'MENTEE', sessionsValidFrom: null });
    const company = await prisma.company.findUnique({ where: { id: other.company.id }, select: { name: true } });
    expect(company?.name).toBe(other.company.name);
    expect(await prisma.passwordResetToken.count({ where: { userId: other.mentee.id } })).toBe(0);
  });

  test(`the /admin dashboard shows only the own tenant's people · ${label}`, async ({ page }) => {
    const [own, other] = pick(tenants);
    await signInAsTenantActor(page, own.admin);
    // Server-rendered, so it bypasses every API route above (#2542 review):
    // "Recent candidates" printed the newest mentees of every tenant.
    const res = await page.request.get('/admin');
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html, '/admin leaked another tenant\'s mentee').not.toContain(other.mentee.email);
    expect(html).not.toContain(`/admin/candidates/${other.mentee.id}`);
    if (own.org.vertical === 'MARKETING') {
      // The MARKETING tenant holds exactly the fixture's rows, so its own
      // mentee is certainly among its five newest — the positive twin.
      expect(html).toContain(`/admin/candidates/${own.mentee.id}`);
    }
  });
}

/**
 * A signed-in admin whose JWT carries `orgId: null` — minted before the deploy
 * backfill stamped the account — is the DEFAULT org's, by the same rule as a
 * NULL-org row. Reading it as "unscoped" failed open: that admin saw, and could
 * act by id on, the MARKETING tenant (#2542 review).
 */
test('an admin session with no org is the default org\'s, never unscoped', async ({ page }) => {
  const adminEmail = uniqueEmail('null-org-session-admin');
  const admin = await seedUser(adminEmail, 'NullOrg123!', 'ADMIN', 'Null Org Session Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: null } });
  const { orgB } = tenants;
  try {
    await putOnWorld(page, 'INTERNSHIP'); // a NULL-org account is the default (INTERNSHIP) world's (#2590)
    await signInAsFreshUser(page, adminEmail, 'NullOrg123!', '/admin');
    const session = await (await page.request.get('/api/auth/session')).json();
    expect(session?.user?.orgId ?? null, 'precondition: the session carries no org').toBeNull();

    expect(await ids(page, '/api/users?role=MENTEE', 'users')).not.toContain(orgB.mentee.id);
    expect(await ids(page, '/api/candidates?all=1', 'candidates')).not.toContain(orgB.mentee.id);
    expect(await ids(page, '/api/companies?all=1', 'companies')).not.toContain(orgB.company.id);
    for (const path of [
      `/api/users/${orgB.mentee.id}`,
      `/api/companies/${orgB.company.id}`,
      `/api/companies/${orgB.company.id}/delete-impact`,
    ]) {
      expect((await page.request.get(path)).status(), `${path} must be a 404`).toBe(404);
    }
    const reset = await page.request.post(`/api/admin/users/${orgB.mentee.id}/reset-password`);
    expect(reset.status()).toBe(404);
    expect(await prisma.passwordResetToken.count({ where: { userId: orgB.mentee.id } })).toBe(0);
    // The positive twin: its own (NULL-org) account is still readable.
    expect((await page.request.get(`/api/users/${admin.id}`)).status()).toBe(200);
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

/**
 * A row whose `orgId` is still NULL is the DEFAULT org's — the rule the deploy
 * backfill applies (src/lib/tenantFilter.ts). So a not-yet-backfilled row stays
 * on the default org's screens and is invisible to every other tenant, rather
 * than vanishing for everyone (a strict `orgId = …`) or leaking to everyone
 * (no filter at all).
 *
 * Flag-off behaviour by definition: with MT_ENFORCE_ISOLATION on, the
 * middleware matches `orgId` strictly, which is why rollout step 1 is a green
 * backfill (no NULL rows left). This spec runs on the default project only.
 */
test('a NULL-org row belongs to the default org: listed there, invisible to a MARKETING admin', async ({ page }) => {
  const defaultOrg = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
  });
  const stamp = Date.now();
  const adminEmail = uniqueEmail('null-org-default-admin');
  const menteeEmail = uniqueEmail('null-org-mentee');
  const admin = await seedUser(adminEmail, 'NullOrg123!', 'ADMIN', 'Default Org Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: defaultOrg.id } });
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', `Null Org Mentee ${stamp}`);
  const company = await prisma.company.create({ data: { name: `Null Org Company ${stamp}` } });
  try {
    await signInAsTenantActor(page, tenants.orgB.admin);
    expect(await ids(page, '/api/users?role=MENTEE', 'users')).not.toContain(mentee.id);
    expect(await ids(page, '/api/candidates?all=1', 'candidates')).not.toContain(mentee.id);
    expect(await ids(page, '/api/companies?all=1', 'companies')).not.toContain(company.id);
    expect((await page.request.get(`/api/users/${mentee.id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/companies/${company.id}`)).status()).toBe(404);

    // Back to the default host: the previous sign-in left the context on the
    // marketing host, where this INTERNSHIP-world admin has no session (#2590).
    await putOnWorld(page, 'INTERNSHIP');
    await signInAsFreshUser(page, adminEmail, 'NullOrg123!', '/admin');
    expect(await ids(page, '/api/users?role=MENTEE', 'users')).toContain(mentee.id);
    expect(await ids(page, '/api/candidates?all=1', 'candidates')).toContain(mentee.id);
    expect(await ids(page, '/api/companies?all=1', 'companies')).toContain(company.id);
    expect((await page.request.get(`/api/users/${mentee.id}`)).status()).toBe(200);
    expect((await page.request.get(`/api/companies/${company.id}`)).status()).toBe(200);
    // …and the default org still does not see the MARKETING tenant.
    expect(await ids(page, '/api/users?role=MENTEE', 'users')).not.toContain(tenants.orgB.mentee.id);
  } finally {
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
    await prisma.company.deleteMany({ where: { id: company.id } });
  }
});

test('a company created by an admin lands in their own tenant and stays out of the other', async ({ page }) => {
  const { orgA, orgB } = tenants;
  await signInAsTenantActor(page, orgB.admin);
  const name = `MARKETING-only account ${Date.now()}`;
  const created = await page.request.post('/api/companies', { data: { name } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).company.id as string;
  try {
    // Stamped with the creator's org by hand: with the flag off nothing else
    // would, and a NULL-org row would vanish from the creator's own list.
    const row = await prisma.company.findUniqueOrThrow({ where: { id }, select: { orgId: true } });
    expect(row.orgId).toBe(orgB.org.id);
    expect(await ids(page, '/api/companies?all=1', 'companies')).toContain(id);

    await signInAsTenantActor(page, orgA.admin);
    expect(await ids(page, '/api/companies?all=1', 'companies')).not.toContain(id);
    expect((await page.request.get(`/api/companies/${id}`)).status()).toBe(404);
  } finally {
    await prisma.company.deleteMany({ where: { id } });
  }
});
