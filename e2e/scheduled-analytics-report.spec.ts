import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

test.afterAll(async () => {
  await prisma.$disconnect();
});

const KEY = 'premiumAnalytics';

async function defaultOrg() {
  return prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
}

// Premium Faz 2 (#541): the weekly analytics report email job is a no-op while
// the premiumAnalytics setting is off, and reports sends once enabled (SMTP is
// unset in CI, so sendEmail no-ops — the job still counts recipients). Restores
// the flag in finally.
//
// Since #2680 the report is per org: GET /api/cron answers with the CALLER'S
// org entry only, so `locked`/`sent` below are this admin's tenant's.
test('weekly analytics report is locked by default and sends to admins once enabled', async ({ page }) => {
  const adminEmail = uniqueEmail('wa-admin');
  const pw = 'WeeklyPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Weekly Admin');
  // The flag below is flipped through the settings route, which writes either
  // the global row or (#2628) the default org's own row. A default-org row left
  // by another spec would shadow the former, so start from none and put back
  // whatever was there.
  const def = await defaultOrg();
  const before = await prisma.setting.findFirst({ where: { orgId: def.id, key: KEY }, select: { value: true } });
  await prisma.setting.deleteMany({ where: { orgId: def.id, key: KEY } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Flag off → the job reports itself locked and sends nothing.
    const off = await page.request.get('/api/cron');
    expect(off.ok()).toBeTruthy();
    const lockedReport = (await off.json()).analyticsReport;
    expect(lockedReport.locked).toBe(true);
    expect(lockedReport.sent).toBe(0);

    // Enable the tier → the job runs and counts at least this admin.
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } });
    const on = await page.request.get('/api/cron');
    expect(on.ok()).toBeTruthy();
    const report = (await on.json()).analyticsReport;
    expect(report.locked).toBe(false);
    expect(report.sent).toBeGreaterThanOrEqual(1);
    // Only the caller's own entry — never the other tenants' counts.
    expect(report.orgs).toBeUndefined();
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await prisma.setting.deleteMany({ where: { orgId: def.id, key: KEY } });
    if (before) await prisma.setting.create({ data: { orgId: def.id, key: KEY, value: before.value } });
    await cleanupByEmail(adminEmail);
  }
});

// #2680: two tenants on one database (#2542). Each org is gated on ITS OWN setting,
// counts only ITS OWN relations, and mails only ITS OWN admins. The EmailLog
// ledger is written even without SMTP (as SKIPPED/FAILED), so "who got a
// report" is read from there by recipient address.
const PW = 'WeeklyTenant123!';

async function setOrgSetting(orgId: string, value: string) {
  await prisma.setting.deleteMany({ where: { orgId, key: KEY } });
  await prisma.setting.create({ data: { orgId, key: KEY, value } });
}

async function runReport(jar: APIRequestContext) {
  const res = await jar.get('/api/cron?job=analytics-report');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).analyticsReport as { orgId: string; locked: boolean; sent: number; total: number; orgs?: unknown };
}

async function reportsTo(email: string) {
  return prisma.emailLog.count({ where: { to: email, category: 'analytics-report' } });
}

test('each tenant gets its own report: own gate, own numbers, own admins (#2680)', async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const mkt = await prisma.organization.create({
    data: { name: `Weekly MKT ${stamp}`, slug: `weekly-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  const def = await defaultOrg();

  const mktAdmin = uniqueEmail('wa-mkt-admin');
  const intAdmin = uniqueEmail('wa-int-admin');
  const mktMentor = uniqueEmail('wa-mkt-mentor');
  const mktMentee = uniqueEmail('wa-mkt-mentee');
  await seedUser(mktAdmin, PW, 'ADMIN', 'Weekly MKT Admin', { orgId: mkt.id });
  await seedUser(intAdmin, PW, 'ADMIN', 'Weekly INT Admin', { orgId: def.id });
  const mentor = await seedUser(mktMentor, PW, 'MENTOR', 'Weekly MKT Mentor', { orgId: mkt.id });
  const mentee = await seedUser(mktMentee, PW, 'MENTEE', 'Weekly MKT Mentee', { orgId: mkt.id });
  // Exactly one relation in the marketing tenant.
  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, orgId: mkt.id } });

  const before = await prisma.setting.findFirst({ where: { orgId: def.id, key: KEY }, select: { value: true } });
  const mktJar = await playwright.request.newContext({ baseURL, extraHTTPHeaders: asHost(MARKETING_HOST) });
  const intJar = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(mktJar, mktAdmin, PW, { host: MARKETING_HOST, headers: freshIp('wa-mkt') })).error).toBeNull();
    expect((await signInViaApi(intJar, intAdmin, PW, { headers: freshIp('wa-int') })).error).toBeNull();

    // 1. Marketing on, default off: only the marketing admin is mailed, and its
    //    numbers are its own tenant's — one relation, not the whole database.
    await setOrgSetting(mkt.id, 'true');
    await setOrgSetting(def.id, 'false');
    const mktReport = await runReport(mktJar);
    expect(mktReport.orgId).toBe(mkt.id);
    expect(mktReport.locked).toBe(false);
    expect(mktReport.sent).toBe(1);
    expect(mktReport.total).toBe(1);
    expect(mktReport.orgs).toBeUndefined();
    expect(await reportsTo(mktAdmin)).toBe(1);
    expect(await reportsTo(intAdmin)).toBe(0);
    // The default admin's own view: locked. (The job itself runs for every org
    // whoever triggers it, so the marketing admin gets a second report.)
    expect((await runReport(intJar)).locked).toBe(true);
    expect(await reportsTo(intAdmin)).toBe(0);
    expect(await reportsTo(mktAdmin)).toBe(2);

    // 2. The other direction: default on, marketing off. The default org's
    //    totals include its NULL-org rows and never the marketing relation.
    await setOrgSetting(mkt.id, 'false');
    await setOrgSetting(def.id, 'true');
    const intReport = await runReport(intJar);
    expect(intReport.orgId).toBe(def.id);
    expect(intReport.locked).toBe(false);
    expect(intReport.sent).toBeGreaterThanOrEqual(1);
    const defaultTotal = await prisma.mentorshipRelation.count({ where: { OR: [{ orgId: def.id }, { orgId: null }] } });
    expect(intReport.total).toBe(defaultTotal);
    expect(await reportsTo(intAdmin)).toBe(1);
    expect(await reportsTo(mktAdmin)).toBe(2); // unchanged: marketing is off now
    expect((await runReport(mktJar)).locked).toBe(true);
    expect(await reportsTo(mktAdmin)).toBe(2);
  } finally {
    await mktJar.dispose();
    await intJar.dispose();
    await prisma.setting.deleteMany({ where: { orgId: def.id, key: KEY } });
    if (before) await prisma.setting.create({ data: { orgId: def.id, key: KEY, value: before.value } });
    await prisma.emailLog.deleteMany({ where: { to: { in: [mktAdmin, intAdmin] } } });
    for (const e of [mktMentee, mktMentor, mktAdmin, intAdmin]) await cleanupByEmail(e);
    await prisma.setting.deleteMany({ where: { orgId: mkt.id } });
    await prisma.organization.delete({ where: { id: mkt.id } }).catch(() => {});
  }
});
