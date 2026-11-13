import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';

/**
 * Moving a programme's settings between environments (#3622,
 * docs/affiliate-module.md § Moving the settings).
 *
 * Organisation A's settings are exported and imported into organisation B —
 * standing in for "another environment". What this pins:
 *   - the file carries the settings and the theme's media, and no partner;
 *   - an observer may export but not import; the import writes only the
 *     caller's own organisation;
 *   - the preview writes nothing; the plan is never in the default selection
 *     and the server refuses it without confirmation;
 *   - applied, every section lands through its own writer (contract version,
 *     plan version, the media as B's own upload) and a second import changes
 *     nothing and adds no upload;
 *   - a damaged file is refused before anything is written.
 *
 * SYNTHETIC ONLY: throwaway MARKETING orgs, example hosts.
 */

const PW = 'AffTransfer123!';
const host = asHost(MARKETING_HOST);

const PLAN = {
  currency: 'EUR',
  tiers: [{ upToMinor: 2_000, commissionMinor: 5_000 }],
  topCommissionMinor: 15_000,
  percentBps: 0,
  switchAtCustomer: null,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 30,
  afterNotice: 'RUN_OUT',
};
const COPY = { en: { heroTitle: 'Acme Sales partner programme', intro: 'Synthetic introduction.' } };
const THEME = {
  colors: { primary: '#c2410c', secondary: '#6d28d9', heading: '#0b1f4d', text: '#3f3f46', background: '#ffffff', surface: '#f4f4f5' },
  headingFont: 'poppins',
  bodyFont: 'manrope',
  animation: 'rise',
};
const CONTRACT = { en: 'Synthetic partner contract.', de: 'Synthetischer Partnervertrag.' };
// A 1×1 PNG: real bytes, so the signature check passes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test.describe.configure({ mode: 'serial' });

const orgs = { a: '', b: '' };
const emails = { a: '', b: '', observer: '' };
const contexts: APIRequestContext[] = [];
let adminA: APIRequestContext;
let adminB: APIRequestContext;
let observerB: APIRequestContext;
let logoA = '';
let exported: Record<string, unknown> & { sections: Record<string, unknown>; assets: { id: string; sha256: string; data: string }[] } = {
  sections: {},
  assets: [],
};

const importFile = (ctx: APIRequestContext, query: string, data: unknown) =>
  ctx.post(`/api/admin/affiliate/settings/import?${query}`, { headers: { ...host, 'content-type': 'application/json' }, data: data as object });
const settingsOf = (orgId: string) => prisma.affiliateProgramSettings.findUnique({ where: { orgId } });

test.beforeAll(async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  orgs.a = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-xfer-a-${stamp}`, vertical: 'MARKETING' } })).id;
  orgs.b = (await prisma.organization.create({ data: { name: `Beta Sales ${stamp}`, slug: `aff-xfer-b-${stamp}`, vertical: 'MARKETING' } })).id;
  emails.a = uniqueEmail('aff-xfer-a');
  emails.b = uniqueEmail('aff-xfer-b');
  emails.observer = uniqueEmail('aff-xfer-obs');
  await seedUser(emails.a, PW, 'ADMIN', 'Admin A', { orgId: orgs.a });
  await seedUser(emails.b, PW, 'ADMIN', 'Admin B', { orgId: orgs.b });
  const obs = await seedUser(emails.observer, PW, 'ADMIN', 'Observer B', { orgId: orgs.b });
  await prisma.user.update({ where: { id: obs.id }, data: { adminLevel: 'OBSERVER' } });
  // A partner in A: it must never appear in the file.
  await prisma.affiliatePartner.create({ data: { orgId: orgs.a, code: 'xfer-secret', displayName: 'Secret Partner Name' } });

  const signIn = async (email: string) => {
    const ctx = await playwright.request.newContext({ baseURL });
    contexts.push(ctx);
    expect((await signInViaApi(ctx, email, PW, { host: MARKETING_HOST })).ok, email).toBe(true);
    return ctx;
  };
  adminA = await signIn(emails.a);
  adminB = await signIn(emails.b);
  observerB = await signIn(emails.observer);

  // A's settings, each through its own screen route.
  const logo = await adminA.post('/api/admin/affiliate/settings/landing/assets', { headers: host, multipart: { file: { name: 'logo.png', mimeType: 'image/png', buffer: PNG } } });
  expect(logo.status()).toBe(201);
  logoA = (await logo.json()).id;
  expect((await adminA.put('/api/admin/affiliate/settings/landing', { headers: host, data: { landing: { copy: COPY, theme: { ...THEME, media: { logo: logoA } } } } })).status()).toBe(200);
  expect((await adminA.put('/api/admin/affiliate/settings/contract', { headers: host, data: { texts: CONTRACT } })).status()).toBe(200);
  expect((await adminA.put('/api/admin/affiliate/settings/plan', { headers: host, data: PLAN })).status()).toBe(200);
  expect((await adminA.put('/api/admin/affiliate/settings/referral-url', { headers: host, data: { referralUrl: 'https://shop.example/signup' } })).status()).toBe(200);
  expect((await adminA.put('/api/admin/affiliate/settings/customer-status', { headers: host, data: { freeMonths: 3, passiveAfterDays: 60 } })).status()).toBe(200);
  expect((await adminA.put('/api/admin/affiliate/settings/window-notice', { headers: host, data: { windowNoticeDays: 21 } })).status()).toBe(200);
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const id of [orgs.a, orgs.b].filter(Boolean)) {
    await prisma.job.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateLandingAsset.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  for (const e of Object.values(emails)) if (e) await cleanupByEmail(e);
  for (const id of [orgs.a, orgs.b].filter(Boolean)) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
});

test('the export is a download of the settings and the theme media — no partner, no organisation', async () => {
  const res = await adminA.get('/api/admin/affiliate/settings/export', { headers: host });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-disposition']).toMatch(/^attachment; filename="affiliate-settings-\d{4}-\d{2}-\d{2}\.json"$/);
  expect(res.headers()['cache-control']).toContain('no-store');
  const text = await res.text();
  expect(text).not.toContain('Secret Partner Name');
  expect(text).not.toContain('xfer-secret');
  expect(text).not.toContain(orgs.a);
  exported = JSON.parse(text);
  expect(exported).toMatchObject({ format: 'affiliate-settings', version: 1 });
  expect(Object.keys(exported.sections).sort()).toEqual(['contract', 'customerStatus', 'landing', 'plan', 'referralUrl', 'windowNotice']);
  expect(exported.sections).toMatchObject({ contract: CONTRACT, referralUrl: 'https://shop.example/signup', customerStatus: { freeMonths: 3, passiveAfterDays: 60 }, windowNotice: 21 });
  expect(exported.assets).toHaveLength(1);
  expect(exported.assets[0]).toMatchObject({ id: logoA, sha256: crypto.createHash('sha256').update(PNG).digest('hex'), data: PNG.toString('base64') });
  const audit = await prisma.auditLog.findFirst({ where: { orgId: orgs.a, action: 'affiliate.settings.export' } });
  expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ assets: 1 });
});

test('an observer may export but not import', async () => {
  expect((await observerB.get('/api/admin/affiliate/settings/export', { headers: host })).status()).toBe(200);
  expect((await importFile(observerB, 'dryRun=1', exported)).status()).toBe(403);
});

test('the preview writes nothing and never pre-selects the plan', async () => {
  const res = await importFile(adminB, 'dryRun=1', exported);
  expect(res.status()).toBe(200);
  const body = await res.json();
  // Neither the plan nor the contract (a new version re-locks every partner) is pre-selected.
  expect(body.defaultSelection).toEqual(['landing', 'customerStatus', 'windowNotice', 'referralUrl']);
  for (const p of body.preview) expect(p, p.section).toMatchObject({ status: 'changed', issues: [] });
  // The small settings say from what to what.
  expect(body.preview.find((p: { section: string }) => p.section === 'referralUrl')).toMatchObject({ from: null, to: 'https://shop.example/signup' });
  expect(body.preview.find((p: { section: string }) => p.section === 'windowNotice')).toMatchObject({ from: 30, to: 21 });
  expect(await settingsOf(orgs.b)).toBeNull();
  expect(await prisma.affiliateLandingAsset.count({ where: { orgId: orgs.b } })).toBe(0);
});

test('the server refuses the plan without its confirmation, and a bad selection', async () => {
  const sel = 'sections=landing,plan';
  expect(await (await importFile(adminB, sel, exported)).json()).toEqual({ code: 'plan_unconfirmed' });
  expect(await (await importFile(adminB, 'sections=', exported)).json()).toEqual({ code: 'empty' });
  expect(await (await importFile(adminB, 'sections=partners', exported)).json()).toEqual({ code: 'unknown_section' });
  expect(await settingsOf(orgs.b)).toBeNull();
});

test('a damaged or foreign file is refused before anything is written', async () => {
  const tampered = { ...exported, assets: [{ ...exported.assets[0], sha256: '0'.repeat(64) }] };
  const preview = await (await importFile(adminB, 'dryRun=1', tampered)).json();
  expect(preview.preview.find((p: { section: string }) => p.section === 'landing')).toMatchObject({ status: 'invalid', issues: ['theme.media.logo:checksum'] });
  const applied = await importFile(adminB, 'sections=landing,contract', tampered);
  expect(applied.status()).toBe(400);
  expect(await applied.json()).toMatchObject({ code: 'invalid' });
  expect((await importFile(adminB, 'dryRun=1', { format: 'something-else' })).status()).toBe(400);
  expect(await (await importFile(adminB, 'dryRun=1', { ...exported, version: 99 })).json()).toEqual({ code: 'version' });
  expect(await settingsOf(orgs.b)).toBeNull();
});

test('applied, each section lands through its own writer; the media become B’s own upload', async () => {
  const res = await importFile(adminB, 'sections=landing,contract,customerStatus,windowNotice,referralUrl', exported);
  expect(res.status()).toBe(200);
  expect((await res.json()).applied.every((a: { changed: boolean }) => a.changed)).toBe(true);

  const b = await settingsOf(orgs.b);
  expect(b).toMatchObject({ contractVersion: 1, planVersion: 0, plan: null, referralUrl: 'https://shop.example/signup', freeMonths: 3, passiveAfterDays: 60, windowNoticeDays: 21 });
  const media = (b?.landing as { theme: { media: { logo: string } } }).theme.media;
  expect(media.logo).not.toBe(logoA);
  const asset = await prisma.affiliateLandingAsset.findUnique({ where: { id: media.logo } });
  expect(asset?.orgId).toBe(orgs.b);
  expect(Buffer.from(asset!.data).equals(PNG)).toBe(true);
  // A is untouched.
  expect(await prisma.affiliateLandingAsset.count({ where: { orgId: orgs.a } })).toBe(1);

  const actions = (await prisma.auditLog.findMany({ where: { orgId: orgs.b }, select: { action: true } })).map((r) => r.action);
  expect(actions).toEqual(expect.arrayContaining(['affiliate.landing.update', 'affiliate.contract.publish', 'affiliate.settings.import']));
});

test('importing the same file again changes nothing and adds no upload', async () => {
  const preview = await (await importFile(adminB, 'dryRun=1', exported)).json();
  for (const p of preview.preview) expect(p, p.section).toMatchObject({ status: p.section === 'plan' ? 'changed' : 'same' });
  const again = await importFile(adminB, 'sections=landing,contract', exported);
  expect((await again.json()).applied).toEqual([
    { section: 'landing', changed: false },
    { section: 'contract', changed: false },
  ]);
  expect(await prisma.affiliateLandingAsset.count({ where: { orgId: orgs.b } })).toBe(1);
  expect((await settingsOf(orgs.b))?.contractVersion).toBe(1);
});

test('an address never entered is not exported, so an import cannot clear the target’s', async () => {
  // B now has an address; A clears its own and exports again.
  expect((await adminA.put('/api/admin/affiliate/settings/referral-url', { headers: host, data: { referralUrl: null } })).status()).toBe(200);
  const file = await (await adminA.get('/api/admin/affiliate/settings/export', { headers: host })).json();
  expect(file.sections).not.toHaveProperty('referralUrl');
  expect((await importFile(adminB, 'sections=referralUrl', file)).status()).toBe(400); // not_in_file
  expect((await settingsOf(orgs.b))?.referralUrl).toBe('https://shop.example/signup');
});

test('the plan lands only with its confirmation, as a new plan version', async () => {
  const res = await importFile(adminB, 'sections=plan&confirmPlan=1', exported);
  expect(res.status()).toBe(200);
  const b = await settingsOf(orgs.b);
  expect(b?.planVersion).toBe(1);
  expect(b?.plan).toMatchObject({ currency: 'EUR', payoutDays: 30 });
  expect(await prisma.auditLog.count({ where: { orgId: orgs.b, action: 'affiliate.plan.update' } })).toBe(1);
});
