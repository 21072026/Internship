import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { invalidateHostOrgCache, resolveOrgFromHost } from '../src/lib/hostOrg';

// Host → tenant resolution (#1661), against seeded orgs:
//   • a VERIFIED own domain resolves to its org; an unverified claim to nobody;
//   • `<slug>.<APP_ROOT_DOMAIN>` resolves only while APP_ROOT_DOMAIN is set;
//   • the product's own host resolves to nobody;
//   • a resolved host never changes data scope: a signed-in admin of org A
//     reading through org B's verified domain still reads org A.
// Hostnames are reserved example names (RFC 2606).

const PW = 'HostOrg123!';

test.describe('host → org resolution', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('ho-admin');
  const verifiedHost = `b-${stamp}.tenant.example.test`;
  const unverifiedHost = `c-${stamp}.tenant.example.test`;
  const ids = { a: '', b: '', c: '' };
  const slugA = `ho-a-${stamp}`;

  test.beforeAll(async () => {
    ids.a = (await prisma.organization.create({ data: { name: `HO A ${stamp}`, slug: slugA } })).id;
    ids.b = (await prisma.organization.create({ data: { name: `HO B ${stamp}`, slug: `ho-b-${stamp}`, publicHost: verifiedHost, publicHostToken: 'tok', publicHostVerifiedAt: new Date() } })).id;
    ids.c = (await prisma.organization.create({ data: { name: `HO C ${stamp}`, slug: `ho-c-${stamp}`, publicHost: unverifiedHost, publicHostToken: 'tok' } })).id;
    await seedUser(admin, PW, 'ADMIN', `HO Admin ${stamp}`, ids.a);
    for (const [k, orgId] of Object.entries(ids)) {
      await prisma.survey.create({ data: { orgId, key: `ho_${k}`, title: { en: `HO survey ${k} ${stamp}` }, audience: 'MENTEE', anonymity: 'CONFIDENTIAL' } });
    }
  });

  test.afterAll(async () => {
    delete process.env.APP_ROOT_DOMAIN;
    await prisma.survey.deleteMany({ where: { orgId: { in: Object.values(ids) } } });
    await cleanupByEmail(admin);
    await prisma.organization.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await prisma.$disconnect();
  });

  test('a verified domain resolves, an unverified one and the product host do not; a subdomain only with APP_ROOT_DOMAIN', { tag: '@smoke' }, async () => {
    invalidateHostOrgCache();
    expect(await resolveOrgFromHost(verifiedHost)).toMatchObject({ id: ids.b, slug: `ho-b-${stamp}` });
    expect(await resolveOrgFromHost(`${verifiedHost.toUpperCase()}:443`)).toMatchObject({ id: ids.b });
    expect(await resolveOrgFromHost(unverifiedHost)).toBeNull();
    expect(await resolveOrgFromHost('localhost:3000')).toBeNull();

    const sub = `${slugA}.tenants.example.test`;
    delete process.env.APP_ROOT_DOMAIN;
    expect(await resolveOrgFromHost(sub)).toBeNull();
    process.env.APP_ROOT_DOMAIN = 'tenants.example.test';
    invalidateHostOrgCache();
    expect(await resolveOrgFromHost(sub)).toMatchObject({ id: ids.a, slug: slugA });
    expect(await resolveOrgFromHost(`x.${sub}`)).toBeNull();

    // Verifying C makes it resolve once the cache is told.
    await prisma.organization.update({ where: { id: ids.c }, data: { publicHostVerifiedAt: new Date() } });
    invalidateHostOrgCache();
    expect(await resolveOrgFromHost(unverifiedHost)).toMatchObject({ id: ids.c });
    await prisma.organization.update({ where: { id: ids.c }, data: { publicHostVerifiedAt: null } });
    invalidateHostOrgCache();
  });

  test('a host-resolved org never changes data scope for a signed-in admin', { tag: '@smoke' }, async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    const titles = async (headers?: Record<string, string>) => {
      const res = await page.request.get('/api/admin/surveys', { headers });
      expect(res.ok()).toBeTruthy();
      return ((await res.json()).surveys as { title: { en: string } }[]).map((s) => s.title.en);
    };
    const own = await titles();
    expect(own).toContain(`HO survey a ${stamp}`);
    // Through org B's verified domain: still org A's rows, never B's.
    const viaB = await titles({ 'x-forwarded-host': verifiedHost, 'x-forwarded-proto': 'https' });
    expect(viaB).toEqual(own);
    expect(viaB).not.toContain(`HO survey b ${stamp}`);
  });
});
