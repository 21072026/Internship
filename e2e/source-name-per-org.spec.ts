import { test, expect, type Browser, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, asHost, MARKETING_HOST } from './helpers/auth';

// A Source name is unique PER ORG, not globally (#2570).
//
// `Source.name` was a global `@unique`, so a second tenant creating "Google
// Ads" got a 409 about a row it could not even see — and because both create
// routes stamped no orgId, every source any tenant made fell into the default
// org at the next deploy's backfill. Now the key is `(orgId, name)`, the create
// paths stamp the caller's org, and every source read is narrowed to the
// caller's tenant. Pinned here through the real routes:
//   • two orgs create the same name — both 201;
//   • the same org a second time — 409 on the admin route, and the picker route
//     hands back the org's OWN existing row (never the other tenant's);
//   • each admin's list holds only its own row, and a delete by the other
//     tenant's id is a 404 that leaves the row in place.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'SourceOrg123!';

async function adminPage(browser: Browser, email: string, host?: string): Promise<Page> {
  // A MARKETING-org account signs in on the marketing host only (#2590).
  const context = await browser.newContext(host ? { extraHTTPHeaders: asHost(host) } : {});
  const page = await context.newPage();
  await signInAndSettle(page, email, PW, '/admin');
  return page;
}

test('two orgs may both have a Source called X; the same org a second time is a 409', async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const name = `Google Ads ${stamp}`;
  const org = await prisma.organization.create({
    data: { name: `Source Org ${stamp}`, slug: `source-org-${stamp}`, vertical: 'MARKETING' },
  });
  // A: no org on the user = the default org's admin (the backfill's rule).
  const aEmail = uniqueEmail('source-org-a');
  const bEmail = uniqueEmail('source-org-b');
  await seedUser(aEmail, PW, 'ADMIN', 'Source Org Admin A');
  const b = await seedUser(bEmail, PW, 'ADMIN', 'Source Org Admin B');
  await prisma.user.update({ where: { id: b.id }, data: { orgId: org.id } });

  const pageA = await adminPage(browser, aEmail);
  const pageB = await adminPage(browser, bEmail, MARKETING_HOST);
  try {
    const createdA = await pageA.request.post('/api/admin/sources', { data: { name } });
    expect(createdA.status()).toBe(201);
    const idA = ((await createdA.json()) as { source: { id: string } }).source.id;

    const createdB = await pageB.request.post('/api/admin/sources', { data: { name } });
    expect(createdB.status()).toBe(201);
    const idB = ((await createdB.json()) as { source: { id: string } }).source.id;
    expect(idB).not.toBe(idA);

    // Both rows carry their tenant — nothing is left for a backfill to guess.
    const rows = await prisma.source.findMany({ where: { name }, select: { id: true, orgId: true } });
    const byId = new Map(rows.map((r) => [r.id, r.orgId]));
    expect(byId.get(idB)).toBe(org.id);
    const defaultOrg = await prisma.organization.findUniqueOrThrow({ where: { slug: 'default' }, select: { id: true } });
    expect(byId.get(idA)).toBe(defaultOrg.id);

    // The same org a second time: 409 from the admin route (case-insensitive,
    // as the MySQL collation of the unique index is)…
    expect((await pageA.request.post('/api/admin/sources', { data: { name } })).status()).toBe(409);
    expect((await pageB.request.post('/api/admin/sources', { data: { name: name.toUpperCase() } })).status()).toBe(409);
    // …and the picker route answers with the org's OWN row.
    const picked = await pageB.request.post('/api/sources', { data: { name } });
    expect(picked.status()).toBe(200);
    expect(await picked.json()).toMatchObject({ created: false, source: { id: idB } });

    // Each tenant lists only its own.
    const listA = ((await (await pageA.request.get('/api/admin/sources')).json()) as { sources: { id: string }[] }).sources;
    expect(listA.map((s) => s.id)).toContain(idA);
    expect(listA.map((s) => s.id)).not.toContain(idB);
    const pickerB = ((await (await pageB.request.get('/api/sources')).json()) as { sources: { id: string }[] }).sources;
    expect(pickerB.map((s) => s.id)).toEqual([idB]);

    // Another tenant's source is a 404 to delete, and survives the attempt.
    expect((await pageA.request.delete(`/api/admin/sources/${idB}`)).status()).toBe(404);
    expect(await prisma.source.count({ where: { id: idB } })).toBe(1);
    expect((await pageB.request.delete(`/api/admin/sources/${idB}`)).ok()).toBeTruthy();
    expect(await prisma.source.count({ where: { id: idB } })).toBe(0);
  } finally {
    await pageA.context().close();
    await pageB.context().close();
    await prisma.source.deleteMany({ where: { name } }).catch(() => {});
    for (const email of [aEmail, bEmail]) await cleanupByEmail(email);
    await prisma.activityLog.deleteMany({ where: { actorEmail: { in: [aEmail, bEmail] } } }).catch(() => {});
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
