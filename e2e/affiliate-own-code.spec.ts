import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

/**
 * An invited partner chooses its own referral code (#3961).
 *
 * The registration form of a partner invitation shows the partner's code,
 * editable; `POST /api/invite/partner-code` answers only the holder of a live
 * partner invitation (404 for anything else) and says available / current /
 * taken / invalid, never who holds a code. Registration writes the chosen code
 * with the account link: a taken one is refused 409 `code_taken` and creates no
 * account. The code is fixed once the account exists, and once it is in use
 * (a click, a customer, a commission) even before that.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run.
 */

const PW = 'AffOwnCode123!';
const host = asHost(MARKETING_HOST);
const tag = crypto.randomBytes(3).toString('hex');
let orgId = '';
let adminEmail = '';
const partners: Record<'fresh' | 'other' | 'used' | 'ui', { id: string; code: string; email: string }> = {
  fresh: { id: '', code: `own-a-${tag}`, email: '' },
  other: { id: '', code: `Taken-${tag}`, email: '' },
  used: { id: '', code: `own-u-${tag}`, email: '' },
  ui: { id: '', code: `own-ui-${tag}`, email: '' },
};
const contexts: APIRequestContext[] = [];

test.describe.configure({ mode: 'serial' });

type RequestFactory = { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } };

async function context(playwright: RequestFactory, baseURL: string | undefined) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  return ctx;
}

async function inviteToken(admin: APIRequestContext, partnerId: string): Promise<string> {
  const res = await admin.post(`/api/admin/affiliate/partners/${partnerId}/invite`, { headers: host });
  expect(res.status()).toBe(201);
  const row = await prisma.invitationToken.findFirstOrThrow({ where: { orgId, partnerId, revokedAt: null, used: false }, orderBy: { createdAt: 'desc' } });
  return row.token;
}

const ask = (ctx: APIRequestContext, data: Record<string, string>) =>
  ctx.post('/api/invite/partner-code', { headers: { ...host, ...freshIp('partner-code') }, data });

const register = (ctx: APIRequestContext, data: Record<string, unknown>) =>
  ctx.post('/api/register', {
    headers: { ...host, ...freshIp('register affiliate-own-code') },
    data: { password: PW, fullName: 'Own Code Partner', consent: true, ...data },
  });

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${tag}`;
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-own-${stamp}`, vertical: 'MARKETING' } })).id;
  adminEmail = uniqueEmail('aff-own-admin');
  await seedUser(adminEmail, PW, 'ADMIN', 'Own Code Admin', { orgId });
  for (const [key, p] of Object.entries(partners)) {
    p.email = uniqueEmail(`aff-own-${key}`);
    p.id = (await prisma.affiliatePartner.create({ data: { orgId, code: p.code, displayName: `Partner ${key}`, contactEmail: p.email } })).id;
  }
  // A code with a click is printed somewhere already.
  await prisma.affiliateClickDaily.create({ data: { orgId, partnerId: partners.used.id, day: new Date(Date.UTC(2026, 0, 5)), clicks: 1, uniqueClicks: 1 } });
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  await prisma.affiliateClickDaily.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.affiliatePartner.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.invitationToken.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of [adminEmail, ...Object.values(partners).map((p) => p.email)]) if (e) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the invited partner chooses a free code; a taken one is refused', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const admin = await context(playwright, baseURL);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const token = await inviteToken(admin, partners.fresh.id);
  const anon = await context(playwright, baseURL);

  // Only the holder of a live partner invitation is answered.
  expect((await ask(anon, { token: 'not-a-token' })).status()).toBe(404);
  expect((await ask(anon, {})).status()).toBe(404);
  const info = await ask(anon, { token });
  expect(info.status()).toBe(200);
  expect(await info.json()).toEqual({ code: partners.fresh.code, displayName: 'Partner fresh', lock: null });

  // Availability: never who holds it; the unique key ignores case, so does the answer.
  const status = async (code: string) => (await (await ask(anon, { token, code })).json()).status;
  expect(await status(partners.fresh.code)).toBe('current');
  expect(await status(partners.other.code)).toBe('taken');
  expect(await status(partners.other.code.toLowerCase())).toBe('taken');
  expect(await status('.dot-first')).toBe('invalid');
  expect(await status('has space')).toBe('invalid');
  const mine = `mine-${tag}`;
  expect(await status(mine)).toBe('available');
  const body = await (await ask(anon, { token, code: partners.other.code })).text();
  expect(body).not.toContain('Partner other');

  // Registering with a taken or invalid code creates nothing; the invitation stays good.
  const taken = await register(anon, { token, email: partners.fresh.email, partnerCode: partners.other.code.toLowerCase() });
  expect(taken.status()).toBe(409);
  expect((await taken.json()).code).toBe('code_taken');
  const invalid = await register(anon, { token, email: partners.fresh.email, partnerCode: '-x' });
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).code).toBe('code_invalid');
  expect(await prisma.user.count({ where: { email: partners.fresh.email, orgId } })).toBe(0);

  // A free code is written with the account link, and audited old → new.
  const ok = await register(anon, { token, email: partners.fresh.email, partnerCode: mine });
  expect(ok.status()).toBe(201);
  const partner = await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: partners.fresh.id }, select: { code: true, userId: true } });
  expect(partner.code).toBe(mine);
  expect(partner.userId).not.toBeNull();
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { orgId, action: 'affiliate.partner.code_chosen', targetId: partners.fresh.id } });
  expect(JSON.parse(audit.detail ?? '{}')).toMatchObject({ from: partners.fresh.code, to: mine });

  // With the account open the invitation is spent: nothing is answered any more.
  expect((await ask(anon, { token })).status()).toBe(404);
});

test('a code in use is fixed even before the account exists', async ({ playwright, baseURL }) => {
  const admin = await context(playwright, baseURL);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const token = await inviteToken(admin, partners.used.id);
  const anon = await context(playwright, baseURL);

  expect(await (await ask(anon, { token })).json()).toEqual({ code: partners.used.code, displayName: 'Partner used', lock: 'in_use' });
  const refused = await register(anon, { token, email: partners.used.email, partnerCode: `new-${tag}` });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).code).toBe('code_locked');
  // Sending the current code (or none) registers as before.
  expect((await register(anon, { token, email: partners.used.email, partnerCode: partners.used.code })).status()).toBe(201);
  expect((await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: partners.used.id } })).code).toBe(partners.used.code);
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.partner.code_chosen', targetId: partners.used.id } })).toBe(0);
});

test('the registration form shows the code, warns about a taken one and keeps the chosen one', async ({ page, playwright, baseURL }) => {
  const admin = await context(playwright, baseURL);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const token = await inviteToken(admin, partners.ui.id);

  await page.context().setExtraHTTPHeaders({ ...host, ...freshIp('register affiliate-own-code ui') });
  await page.goto(`/auth/register?token=${encodeURIComponent(token)}`);
  const input = page.getByTestId('partner-code-input');
  await expect(input).toHaveValue(partners.ui.code);

  // A taken code (case aside) warns while typing.
  await input.fill(partners.other.code.toUpperCase());
  await expect(page.getByTestId('partner-code-field')).toContainText(/taken|alınmış|vergeben/);

  // "Suggest another" fills a fresh random code, which is available.
  await page.getByTestId('partner-code-random').click();
  await expect(input).toHaveValue(/^[a-z2-9]{8}$/);
  await expect(page.getByTestId('partner-code-status')).toHaveText(/Available|Uygun|Verfügbar/);

  // A code of one's own, then register.
  const chosen = `ui-${tag}`;
  await input.fill(chosen);
  await expect(page.getByTestId('partner-code-status')).toHaveText(/Available|Uygun|Verfügbar/);
  await page.getByLabel(/full name|ad soyad|vollständiger name/i).fill('Own Code Partner');
  await page.locator('input[type="password"]').first().fill(PW);
  await page.locator('input[type="password"]').nth(1).fill(PW);
  await page.locator('input[type="checkbox"]').first().check();
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname === '/auth/signin', { timeout: 20_000 });
  expect((await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: partners.ui.id } })).code).toBe(chosen);
});
