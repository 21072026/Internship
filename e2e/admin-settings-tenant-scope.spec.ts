import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

// PUT /api/admin/settings writes the CALLER'S OWN org row (#2628).
//
// It used to write the global row (orgId = NULL): with MT_ENFORCE_ISOLATION off
// — every deployment today — `withTenantScope` bound no org, so `setSetting`
// fell through to the global layer, which is the platform default every tenant
// without its own override inherits. One MARKETING admin ticking "premium
// analytics" therefore switched it on for the INTERNSHIP tenant as well.
//
// Pinned over HTTP against the ordinary (flag-off) server, because that is
// where the bug lived: two tenants on one database, each admin in its own
// world (the marketing admin signs in on the marketing host, #2590), each
// seeing and writing only its own value — and the global row untouched by both.

const PW = 'TenantSettings123!';
const KEY = 'premiumAnalytics';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function defaultOrg() {
  return prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
}

async function settingsOf(jar: APIRequestContext, headers: Record<string, string> = {}) {
  const res = await jar.get('/api/admin/settings', { headers });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { settings: Record<string, string> }).settings;
}

test('a MARKETING admin toggling a setting changes only its own tenant; each tenant sees its own value', async ({
  playwright,
  baseURL,
}) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const mkt = await prisma.organization.create({
    data: { name: `Settings MKT ${stamp}`, slug: `settings-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  const def = await defaultOrg();

  const mktEmail = uniqueEmail('settings-mkt-admin');
  const intEmail = uniqueEmail('settings-int-admin');
  await seedUser(mktEmail, PW, 'ADMIN', 'Marketing Settings Admin', { orgId: mkt.id });
  await seedUser(intEmail, PW, 'ADMIN', 'Internship Settings Admin', { orgId: def.id });

  // The shared DB may already hold rows for these keys (other specs save them
  // through the same API); remember them exactly so `finally` puts them back.
  const touched = [KEY, 'reminderDays', 'jobRetentionDays'];
  const before = await prisma.setting.findMany({
    where: { key: { in: touched }, OR: [{ orgId: null }, { orgId: def.id }] },
    select: { orgId: true, key: true, value: true },
  });

  const mktHost = asHost(MARKETING_HOST);
  const mktJar = await playwright.request.newContext({ baseURL, extraHTTPHeaders: mktHost });
  const intJar = await playwright.request.newContext({ baseURL });
  try {
    // A known starting point for the INTERNSHIP tenant: premium off.
    await prisma.setting.deleteMany({ where: { orgId: def.id, key: KEY } });
    await prisma.setting.create({ data: { orgId: def.id, key: KEY, value: 'false' } });
    const globalBefore = await prisma.setting.findFirst({ where: { orgId: null, key: KEY }, select: { value: true } });

    expect((await signInViaApi(mktJar, mktEmail, PW, { host: MARKETING_HOST, headers: freshIp('settings-mkt') })).error).toBeNull();
    expect((await signInViaApi(intJar, intEmail, PW, { headers: freshIp('settings-int') })).error).toBeNull();

    // 1. The MARKETING admin switches premium analytics on — for itself.
    const put = await mktJar.put('/api/admin/settings', { data: { [KEY]: 'true' } });
    expect(put.ok()).toBeTruthy();
    expect(((await put.json()) as { settings: Record<string, string> }).settings[KEY]).toBe('true');

    // It landed on the marketing org's row…
    const mktRow = await prisma.setting.findFirst({ where: { orgId: mkt.id, key: KEY }, select: { value: true } });
    expect(mktRow?.value).toBe('true');
    // …and NOT on the global row every tenant inherits.
    expect(await prisma.setting.findFirst({ where: { orgId: null, key: KEY }, select: { value: true } })).toEqual(globalBefore);

    // 2. Each tenant reads its own effective value — on the settings page and
    //    through the gate that actually decides access.
    expect((await settingsOf(mktJar))[KEY]).toBe('true');
    expect((await settingsOf(intJar))[KEY]).toBe('false');
    const mktEnt = await (await mktJar.get('/api/admin/analytics/entitlements')).json();
    const intEnt = await (await intJar.get('/api/admin/analytics/entitlements')).json();
    expect(mktEnt.premiumAnalytics).toBe(true);
    expect(intEnt.premiumAnalytics).toBe(false);
    expect((await mktJar.get('/api/admin/analytics/cohorts')).status()).not.toBe(403);
    expect((await intJar.get('/api/admin/analytics/cohorts')).status()).toBe(403);

    // 3. The other direction: the INTERNSHIP admin's write stays in its tenant.
    const intPut = await intJar.put('/api/admin/settings', { data: { reminderDays: '33' } });
    expect(intPut.ok()).toBeTruthy();
    expect((await settingsOf(intJar)).reminderDays).toBe('33');
    expect((await settingsOf(mktJar)).reminderDays).not.toBe('33');
    expect(await prisma.setting.findFirst({ where: { orgId: mkt.id, key: 'reminderDays' } })).toBeNull();

    // 4. A deployment-global key is not a tenant admin's to write: 403, and
    //    nothing else in the same request is written either.
    const global = await mktJar.put('/api/admin/settings', { data: { jobRetentionDays: '5', reminderDays: '44' } });
    expect(global.status()).toBe(403);
    expect(await prisma.setting.findFirst({ where: { key: 'jobRetentionDays', orgId: mkt.id } })).toBeNull();
    expect(await prisma.setting.findFirst({ where: { key: 'reminderDays', orgId: mkt.id } })).toBeNull();
  } finally {
    await mktJar.dispose();
    await intJar.dispose();
    // Restore the default org's and the global rows exactly as they were.
    await prisma.setting.deleteMany({ where: { key: { in: touched }, OR: [{ orgId: null }, { orgId: def.id }] } });
    if (before.length) await prisma.setting.createMany({ data: before });
    await cleanupByEmail(mktEmail);
    await cleanupByEmail(intEmail);
    await prisma.setting.deleteMany({ where: { orgId: mkt.id } });
    await prisma.organization.delete({ where: { id: mkt.id } }).catch(() => {});
  }
});
