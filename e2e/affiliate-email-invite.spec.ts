import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

/**
 * Inviting a partner by e-mail alone (#3963).
 *
 * The admin types an address (a name is optional); the server creates the
 * partner with a placeholder random code and invites it in one step. The
 * partner then names itself and picks its code on the registration form. An
 * address that is a partner's contact already, or has an account in this
 * product, is refused before anything is written. Creating a partner with a
 * code of the admin's choosing still works, folded under "Advanced".
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run.
 */

const PW = 'AffEmailInvite123!';
const host = asHost(MARKETING_HOST);
const tag = crypto.randomBytes(3).toString('hex');
let orgId = '';
let adminEmail = '';
let memberEmail = '';
const partnerEmails: string[] = [];
const contexts: APIRequestContext[] = [];

test.describe.configure({ mode: 'serial' });

type RequestFactory = { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } };

async function context(playwright: RequestFactory, baseURL: string | undefined) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  return ctx;
}

function partnerEmail(label: string): string {
  const e = uniqueEmail(`aff-ei-${label}`);
  partnerEmails.push(e);
  return e;
}

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${tag}`;
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-ei-${stamp}`, vertical: 'MARKETING' } })).id;
  adminEmail = uniqueEmail('aff-ei-admin');
  memberEmail = uniqueEmail('aff-ei-member');
  await seedUser(adminEmail, PW, 'ADMIN', 'Email Invite Admin', { orgId });
  await seedUser(memberEmail, PW, 'MENTOR', 'Existing Member', { orgId });
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  await prisma.affiliatePartner.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.invitationToken.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of [adminEmail, memberEmail, ...partnerEmails]) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('an address alone creates and invites the partner; it names itself and picks its code', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const admin = await context(playwright, baseURL);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const invite = (data: Record<string, string>) => admin.post('/api/admin/affiliate/partners/invite', { headers: host, data });

  const email = partnerEmail('api');
  const res = await invite({ email: email.toUpperCase() });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.code).toMatch(/^[a-z2-9]{8}$/);
  expect(body.inviteError).toBeNull();
  const partner = await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: body.partnerId } });
  expect(partner).toMatchObject({ orgId, code: body.code, contactEmail: email, displayName: email.split('@')[0], userId: null });
  const token = await prisma.invitationToken.findFirstOrThrow({ where: { orgId, partnerId: partner.id, used: false, revokedAt: null } });
  expect(token.role).toBe('AFFILIATE');
  expect(token.email).toBe(email);

  // Refusals, before anything is written.
  const again = await invite({ email });
  expect(again.status()).toBe(409);
  expect((await again.json()).code).toBe('email_is_partner');
  const member = await invite({ email: memberEmail });
  expect(member.status()).toBe(409);
  expect((await member.json()).code).toBe('email_taken');
  const bad = await invite({ email: 'not-an-address' });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).issues).toContain('email');
  expect(await prisma.affiliatePartner.count({ where: { orgId, contactEmail: memberEmail } })).toBe(0);

  // The invitation shows the stand-in name; registration replaces name and code.
  const anon = await context(playwright, baseURL);
  const info = await anon.post('/api/invite/partner-code', { headers: { ...host, ...freshIp('partner-code ei') }, data: { token: token.token } });
  expect(await info.json()).toEqual({ code: body.code, displayName: email.split('@')[0], lock: null });
  const tooLong = await anon.post('/api/register', {
    headers: { ...host, ...freshIp('register aff-ei') },
    data: { token: token.token, email, password: PW, fullName: 'Ada Example', consent: true, partnerName: 'x'.repeat(161) },
  });
  expect(tooLong.status()).toBe(400);
  expect((await tooLong.json()).code).toBe('name_invalid');
  const chosen = `ada-${tag}`;
  const ok = await anon.post('/api/register', {
    headers: { ...host, ...freshIp('register aff-ei') },
    data: { token: token.token, email, password: PW, fullName: 'Ada Example', consent: true, partnerName: '  Ada   Example GmbH ', partnerCode: chosen },
  });
  expect(ok.status()).toBe(201);
  expect(await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: partner.id } })).toMatchObject({ code: chosen, displayName: 'Ada Example GmbH' });
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.partner.create', targetId: partner.id } })).toBe(1);
});

test('the partners page invites by address and keeps the code form under Advanced', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, adminEmail, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/partners');

  // Invite by address, with a name.
  const email = partnerEmail('ui');
  await page.getByTestId('affiliate-invite-email').fill(email);
  await page.getByTestId('affiliate-invite-name').fill(`UI Partner ${tag}`);
  await page.getByTestId('affiliate-email-invite-send').click();
  await expect.poll(async () => prisma.affiliatePartner.count({ where: { orgId, contactEmail: email } })).toBe(1);
  const partner = await prisma.affiliatePartner.findFirstOrThrow({ where: { orgId, contactEmail: email } });
  expect(partner.displayName).toBe(`UI Partner ${tag}`);
  await expect(page.getByTestId(`affiliate-invited-${partner.code}`)).toBeVisible();
  await expect(page.getByTestId('affiliate-invite-email')).toHaveValue('');

  // The code form is folded away, and still creates a partner as before.
  const advanced = page.getByTestId('affiliate-advanced');
  await expect(page.getByTestId('affiliate-new-code')).toBeHidden();
  await advanced.locator('summary').click();
  const code = `adv-${tag}`;
  await page.getByTestId('affiliate-new-code').fill(code);
  await page.getByTestId('affiliate-new-name').fill(`Advanced ${tag}`);
  await page.getByTestId('affiliate-add-partner').click();
  await expect(page.getByTestId(`affiliate-partner-${code}`)).toBeVisible();
  await expect(page.getByTestId(`affiliate-invite-${code}`)).toHaveCount(0); // no contact e-mail → nothing to invite
});

test('the registration form lets the partner name itself', async ({ page, playwright, baseURL }) => {
  const admin = await context(playwright, baseURL);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const email = partnerEmail('form');
  const res = await admin.post('/api/admin/affiliate/partners/invite', { headers: host, data: { email } });
  expect(res.status()).toBe(201);
  const { partnerId } = await res.json();
  const token = await prisma.invitationToken.findFirstOrThrow({ where: { orgId, partnerId, used: false, revokedAt: null } });

  await page.context().setExtraHTTPHeaders({ ...host, ...freshIp('register aff-ei ui') });
  await page.goto(`/auth/register?token=${encodeURIComponent(token.token)}`);
  const name = page.getByTestId('partner-name-input');
  await expect(name).toHaveValue(email.split('@')[0]);
  await name.fill(`Form Partner ${tag}`);
  await page.getByLabel(/full name|ad soyad|vollständiger name/i).fill('Form Person');
  await page.locator('input[type="password"]').first().fill(PW);
  await page.locator('input[type="password"]').nth(1).fill(PW);
  await page.locator('input[type="checkbox"]').first().check();
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname === '/auth/signin', { timeout: 20_000 });
  const partner = await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: partnerId } });
  expect(partner.displayName).toBe(`Form Partner ${tag}`);
  expect(partner.userId).not.toBeNull();
});
