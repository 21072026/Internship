import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

/**
 * A partner's account (docs/affiliate-module.md, #3117).
 *
 * The admin invites a partner to its contact address; registering through that
 * invitation creates an AFFILIATE account linked to the partner in the same
 * transaction. A new invitation withdraws the open one; a partner that already
 * has an account cannot be linked twice; an AFFILIATE token that names no
 * partner creates nothing. The new partner then meets the contract page before
 * anything else, and again whenever a new version is published.
 * @smoke: an account-creation boundary.
 *
 * SYNTHETIC ONLY: throwaway MARKETING orgs per run.
 */

const PW = 'AffInvite123!';
const host = asHost(MARKETING_HOST);
let orgId = '';
let otherOrgId = '';
let adminEmail = '';
let adminId = '';
let partnerId = '';
let partnerEmail = '';
let noEmailPartnerId = '';
let suspendedPartnerId = '';
let otherPartnerId = '';
const extraEmails: string[] = [];
const contexts: APIRequestContext[] = [];

test.describe.configure({ mode: 'serial' });

type RequestFactory = { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } };

async function context(playwright: RequestFactory, baseURL: string | undefined) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  return ctx;
}

async function register(ctx: APIRequestContext, token: string, email: string) {
  return ctx.post('/api/register', {
    headers: { ...host, ...freshIp('register affiliate-invite') },
    data: { token, email, password: PW, fullName: 'Invited Partner', consent: true },
  });
}

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-inv-${stamp}`, vertical: 'MARKETING' } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `Acme Other ${stamp}`, slug: `aff-inv-o-${stamp}`, vertical: 'MARKETING' } })).id;
  adminEmail = uniqueEmail('aff-inv-admin');
  partnerEmail = uniqueEmail('aff-inv-partner');
  adminId = (await seedUser(adminEmail, PW, 'ADMIN', 'Invite Admin', { orgId })).id;
  partnerId = (await prisma.affiliatePartner.create({ data: { orgId, code: 'inv-1', displayName: 'Invited Partner', contactEmail: partnerEmail } })).id;
  noEmailPartnerId = (await prisma.affiliatePartner.create({ data: { orgId, code: 'inv-2', displayName: 'No Address' } })).id;
  suspendedPartnerId = (
    await prisma.affiliatePartner.create({ data: { orgId, code: 'inv-3', displayName: 'Suspended', contactEmail: uniqueEmail('aff-inv-s'), status: 'SUSPENDED' } })
  ).id;
  otherPartnerId = (
    await prisma.affiliatePartner.create({ data: { orgId: otherOrgId, code: 'inv-1', displayName: 'Elsewhere', contactEmail: uniqueEmail('aff-inv-o') } })
  ).id;
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const id of [orgId, otherOrgId].filter(Boolean)) {
    await prisma.affiliateContractAcceptance.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.invitationToken.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  for (const e of [adminEmail, partnerEmail, ...extraEmails]) if (e) await cleanupByEmail(e);
  for (const id of [orgId, otherOrgId].filter(Boolean)) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
});

test('an invitation creates the partner account, linked once', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const admin = await context(playwright, baseURL);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const invite = (id: string) => admin.post(`/api/admin/affiliate/partners/${id}/invite`, { headers: host });

  // Refusals: another organisation's partner reads as missing; no address, not active.
  expect((await invite(otherPartnerId)).status()).toBe(404);
  expect((await invite(noEmailPartnerId)).status()).toBe(400);
  expect((await invite(suspendedPartnerId)).status()).toBe(409);

  // Two invitations: the second withdraws the first.
  const first = await invite(partnerId);
  expect(first.status()).toBe(201);
  const second = await invite(partnerId);
  expect(second.status()).toBe(201);
  expect((await second.json()).withdrawn).toBe(1);
  const tokens = await prisma.invitationToken.findMany({ where: { orgId, partnerId }, orderBy: { createdAt: 'asc' } });
  expect(tokens).toHaveLength(2);
  expect(tokens.every((t) => t.role === 'AFFILIATE' && t.email === partnerEmail)).toBe(true);
  expect(tokens[0].revokedAt).not.toBeNull();
  expect(tokens[1].revokedAt).toBeNull();

  const anon = await context(playwright, baseURL);
  expect((await register(anon, tokens[0].token, partnerEmail)).status()).toBe(400);
  expect((await register(anon, tokens[1].token, partnerEmail)).status()).toBe(201);

  const user = await prisma.user.findFirst({ where: { email: partnerEmail, orgId }, select: { id: true, role: true, emailVerified: true } });
  expect(user?.role).toBe('AFFILIATE');
  expect(user?.emailVerified).toBe(true);
  const partner = await prisma.affiliatePartner.findUnique({ where: { id: partnerId }, select: { userId: true } });
  expect(partner?.userId).toBe(user!.id);
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.partner.account_linked', targetId: partnerId } })).toBe(1);

  // The new partner signs in on the organisation's host and reaches its own record.
  const partnerCtx = await context(playwright, baseURL);
  expect((await signInViaApi(partnerCtx, partnerEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const me = await partnerCtx.get('/api/affiliate/me', { headers: host });
  expect(me.status()).toBe(200);
  expect((await me.json()).code).toBe('inv-1');

  // Linked: no further invitation.
  const again = await invite(partnerId);
  expect(again.status()).toBe(409);
  expect((await again.json()).code).toBe('already_linked');
});

test('a token for a partner that is already linked creates no account', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const late = uniqueEmail('aff-inv-late');
  const forged = uniqueEmail('aff-inv-forged');
  extraEmails.push(late, forged);
  const expiresAt = new Date(Date.now() + 86_400_000);
  const mint = (email: string, pid: string | null) =>
    prisma.invitationToken.create({
      data: { token: crypto.randomBytes(32).toString('hex'), email, role: 'AFFILIATE', orgId, invitedById: adminId, partnerId: pid, expiresAt },
    });

  const anon = await context(playwright, baseURL);
  // A second token for the partner linked above (a race the guarded link must lose).
  const lateToken = await mint(late, partnerId);
  expect((await register(anon, lateToken.token, late)).status()).toBe(400);
  expect(await prisma.user.count({ where: { email: late } })).toBe(0);
  expect((await prisma.invitationToken.findUnique({ where: { id: lateToken.id } }))?.used).toBe(false);

  // An AFFILIATE token that names no partner is not the programme's invitation.
  const forgedToken = await mint(forged, null);
  expect((await register(anon, forgedToken.token, forged)).status()).toBe(400);
  expect(await prisma.user.count({ where: { email: forged } })).toBe(0);
});

test('the invited partner accepts the contract before the portal opens', { tag: '@smoke' }, async ({ page }) => {
  const publish = (version: number, marker: string) =>
    prisma.affiliateProgramSettings.upsert({
      where: { orgId },
      create: { orgId, contract: { en: `Partner terms ${marker}`, tr: `Şartlar ${marker}`, de: `Bedingungen ${marker}` }, contractVersion: version },
      update: { contract: { en: `Partner terms ${marker}`, tr: `Şartlar ${marker}`, de: `Bedingungen ${marker}` }, contractVersion: version },
    });
  await publish(1, 'first');

  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, partnerEmail, PW, '/affiliate');
  await page.waitForURL((u) => u.pathname === '/affiliate/contract', { timeout: 20_000 });
  await expect(page.getByTestId('affiliate-contract-text')).toContainText('first');
  const accept = page.getByTestId('affiliate-contract-accept');
  await expect(accept).toBeDisabled();
  await page.getByTestId('affiliate-contract-agree').check();
  await accept.click();
  await page.waitForURL((u) => u.pathname === '/affiliate', { timeout: 20_000 });
  await expect(page.getByTestId('empty-affiliate-portal')).toBeVisible();
  expect(await prisma.affiliateContractAcceptance.count({ where: { orgId, partnerId, version: 1 } })).toBe(1);

  // A new version holds the portal again, and says which version was accepted.
  await publish(2, 'second');
  await gotoSettled(page, '/affiliate');
  await page.waitForURL((u) => u.pathname === '/affiliate/contract', { timeout: 20_000 });
  await expect(page.getByTestId('affiliate-contract-text')).toContainText('second');
  await expect(page.getByTestId('affiliate-contract-intro')).toBeVisible();
});
