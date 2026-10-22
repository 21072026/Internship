import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';
import { prisma as appPrisma } from '../src/lib/prisma';
import { saveContract, AffiliateContractError } from '../src/lib/affiliateContract';

/**
 * The partner gate and the contract (docs/affiliate-module.md, #3115).
 *
 * Every partner API sits behind affiliatePartnerGate(): AFFILIATE only, the
 * session's OWN partner record, inside a vertical with the affiliate module, and
 * — except for the contract route itself — only once the CURRENT contract version
 * is accepted. A saved contract bumps its version only when a text changed
 * (locale by locale, key order irrelevant). @smoke: a security boundary.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run.
 */

const PW = 'AffGate123!';
const host = asHost(MARKETING_HOST);
let orgId = '';
let partnerUserId = '';
let partnerId = '';
let partnerEmail = '';
let orphanEmail = '';
let leadEmail = '';
let strayEmail = '';
const contexts: APIRequestContext[] = [];

test.describe.configure({ mode: 'serial' });

type RequestFactory = { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } };

async function signedIn(playwright: RequestFactory, baseURL: string | undefined, email: string, onMarketing = true) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW, onMarketing ? { host: MARKETING_HOST } : {})).ok, `${email} sign-in`).toBe(true);
  return ctx;
}

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-gate-${stamp}`, vertical: 'MARKETING' } })).id;
  partnerEmail = uniqueEmail('aff-partner');
  orphanEmail = uniqueEmail('aff-orphan');
  leadEmail = uniqueEmail('aff-lead');
  strayEmail = uniqueEmail('aff-stray');
  const partnerUser = await seedUser(partnerEmail, PW, 'AFFILIATE', 'Gate Partner', { orgId });
  partnerUserId = partnerUser.id;
  await seedUser(orphanEmail, PW, 'AFFILIATE', 'No Partner Record', { orgId });
  await seedUser(leadEmail, PW, 'MENTEE', 'Marketing Lead', { orgId });
  await seedUser(strayEmail, PW, 'AFFILIATE', 'Internship Affiliate');
  partnerId = (await prisma.affiliatePartner.create({ data: { orgId, userId: partnerUser.id, code: 'gate-1', displayName: 'Gate Partner' } })).id;
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  if (orgId) {
    await prisma.affiliateContractAcceptance.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  }
  await prisma.impersonationGrant.deleteMany({ where: { token: { startsWith: 'e2e-aff-' } } }).catch(() => {});
  if (partnerUserId) await prisma.notification.deleteMany({ where: { userId: partnerUserId } }).catch(() => {});
  for (const e of [partnerEmail, orphanEmail, leadEmail, strayEmail]) if (e) await cleanupByEmail(e);
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test('only a partner with a record reaches the partner API', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL });
  contexts.push(anon);
  expect((await anon.get('/api/affiliate/me', { headers: host })).status()).toBe(401);

  const lead = await signedIn(playwright, baseURL, leadEmail);
  expect((await lead.get('/api/affiliate/me', { headers: host })).status()).toBe(403);

  const orphan = await signedIn(playwright, baseURL, orphanEmail);
  expect((await orphan.get('/api/affiliate/me', { headers: host })).status()).toBe(404);

  // An AFFILIATE account in the internship product: the module is not there.
  const stray = await signedIn(playwright, baseURL, strayEmail, false);
  expect((await stray.get('/api/affiliate/me')).status()).toBe(403);

  const partner = await signedIn(playwright, baseURL, partnerEmail);
  const me = await partner.get('/api/affiliate/me', { headers: host });
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ code: 'gate-1', displayName: 'Gate Partner', status: 'ACTIVE', contractVersion: 0 });
});

test('a published contract holds the partner API until the current version is accepted', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const partner = await signedIn(playwright, baseURL, partnerEmail);
  expect(await saveContract(orgId, { en: 'Synthetic terms v1', de: 'Synthetische Bedingungen v1' }, 'e2e-admin')).toEqual({ changed: true, version: 1 });

  expect((await partner.get('/api/affiliate/me', { headers: host })).status()).toBe(409);
  // The contract route is the one partner route that answers before acceptance.
  const contract = await partner.get('/api/affiliate/contract', { headers: host });
  expect(contract.status()).toBe(200);
  expect(await contract.json()).toMatchObject({ currentVersion: 1, mustAccept: true, locale: 'en', text: 'Synthetic terms v1' });

  expect((await partner.post('/api/affiliate/contract', { headers: host, data: { version: 2 } })).status()).toBe(409); // not the current one
  const accepted = await partner.post('/api/affiliate/contract', { headers: host, data: { version: 1 } });
  expect(accepted.status()).toBe(200);
  expect(await accepted.json()).toMatchObject({ currentVersion: 1, acceptedVersion: 1, mustAccept: false });
  expect((await partner.post('/api/affiliate/contract', { headers: host, data: { version: 1 } })).status()).toBe(200); // idempotent
  expect((await partner.get('/api/affiliate/me', { headers: host })).status()).toBe(200);

  // The same texts in another key order: no new version, nobody re-accepts.
  expect(await saveContract(orgId, { de: 'Synthetische Bedingungen v1', en: 'Synthetic terms v1' }, 'e2e-admin')).toEqual({ changed: false, version: 1 });
  expect((await partner.get('/api/affiliate/me', { headers: host })).status()).toBe(200);

  // A changed text: version 2, the partner is held again.
  expect(await saveContract(orgId, { en: 'Synthetic terms v2', de: 'Synthetische Bedingungen v1' }, 'e2e-admin')).toEqual({ changed: true, version: 2 });
  expect((await partner.get('/api/affiliate/me', { headers: host })).status()).toBe(409);
});

test('payout details: validated, sealed, masked on the way out, audited and announced', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const partner = await signedIn(playwright, baseURL, partnerEmail);
  expect((await partner.post('/api/affiliate/contract', { headers: host, data: { version: 2 } })).status()).toBe(200);

  // Contract publish/accept were audited once each, the idempotent repeat included.
  const actions = async (action: string) => prisma.auditLog.count({ where: { orgId, action } });
  expect(await actions('affiliate.contract.publish')).toBe(2);
  expect(await actions('affiliate.contract.accept')).toBe(2);

  const bad = await partner.put('/api/affiliate/me/payout-details', { headers: host, data: { iban: 'DE89 3704 0044 0532 0130 01', holder: '' } });
  expect(bad.status()).toBe(400);
  expect(await bad.json()).toMatchObject({ code: 'invalid_input', issues: ['iban', 'holder'] });

  // A published example IBAN (ISO 13616), never a real account.
  const iban = 'DE89370400440532013000';
  const put = await partner.put('/api/affiliate/me/payout-details', { headers: host, data: { iban: 'de89 3704 0044 0532 0130 00', holder: 'Gate Partner' } });
  expect(put.status()).toBe(200);
  const putText = await put.text();
  expect(putText).not.toContain(iban);
  expect(JSON.parse(putText)).toEqual({ details: { iban: '•••• 3000', holder: 'Gate Partner' } });

  const get = await partner.get('/api/affiliate/me/payout-details', { headers: host });
  expect(await get.text()).not.toContain(iban);

  const row = await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: partnerId }, select: { payoutDetailsCipher: true } });
  expect(row.payoutDetailsCipher).toBeTruthy();
  expect(row.payoutDetailsCipher).not.toContain(iban);

  const audit = await prisma.auditLog.findMany({ where: { orgId, action: 'affiliate.payout_details.update' } });
  expect(audit).toHaveLength(1);
  expect(audit[0].actorId).toBe(partnerUserId);
  expect(audit[0].detail).not.toContain(iban);
  expect(await prisma.notification.count({ where: { userId: partnerUserId, type: 'security.payoutDetailsChanged' } })).toBe(1);

  // A suspended partner's details are frozen.
  await prisma.affiliatePartner.update({ where: { id: partnerId }, data: { status: 'SUSPENDED' } });
  expect((await partner.put('/api/affiliate/me/payout-details', { headers: host, data: { iban, holder: 'Someone Else' } })).status()).toBe(409);
  await prisma.affiliatePartner.update({ where: { id: partnerId }, data: { status: 'ACTIVE' } });
});

test('an empty or malformed contract is refused, never published', { tag: '@smoke' }, async () => {
  for (const texts of [{}, { en: '   ' }, { fr: 'x' } as never]) {
    await expect(saveContract(orgId, texts, 'e2e-admin')).rejects.toMatchObject({ code: 'invalid_contract' });
  }
  expect(AffiliateContractError).toBeTruthy();
  expect((await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { orgId } })).contractVersion).toBe(2);
});

test('the money and declaration writes refuse an impersonating admin and an un-enrolled partner under 2FA', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  // An admin signed in AS the partner (the real grant → session path).
  const token = `e2e-aff-${crypto.randomBytes(8).toString('hex')}`;
  await prisma.impersonationGrant.create({
    data: { token, adminId: partnerUserId, targetId: partnerUserId, kind: 'START', expiresAt: new Date(Date.now() + 60_000) },
  });
  const imp = await playwright.request.newContext({ baseURL });
  contexts.push(imp);
  const csrf = await (await imp.get('/api/auth/csrf', { headers: host })).json();
  await imp.post('/api/auth/callback/impersonate', { headers: host, form: { csrfToken: csrf.csrfToken, grant: token, json: 'true' }, maxRedirects: 0 });
  const session = await (await imp.get('/api/auth/session', { headers: host })).json();
  expect(session?.user?.impersonatorId).toBeTruthy();

  const iban = 'DE89370400440532013000';
  const put = await imp.put('/api/affiliate/me/payout-details', { headers: host, data: { iban, holder: 'Impostor' } });
  expect(put.status()).toBe(400);
  expect(await put.json()).toMatchObject({ code: 'impersonating' });
  expect((await imp.post('/api/affiliate/contract', { headers: host, data: { version: 2 } })).status()).toBe(400);

  // 2FA policy 'all' and the partner has not enrolled: the payout write is refused.
  const partner = await signedIn(playwright, baseURL, partnerEmail);
  await prisma.setting.create({ data: { orgId, key: 'require2fa', value: 'all' } });
  const held = await partner.put('/api/affiliate/me/payout-details', { headers: host, data: { iban, holder: 'Gate Partner' } });
  expect(held.status()).toBe(403);
  expect(await held.json()).toMatchObject({ code: 'two_factor_required' });
  await prisma.setting.deleteMany({ where: { orgId, key: 'require2fa' } });

  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.payout_details.update' } })).toBe(1); // still only the partner's own change
});

test('a partner is sent home from the mentoring pages, never shown the mentee shell', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const partner = await signedIn(playwright, baseURL, partnerEmail);
  for (const path of ['/mentors', '/todos', '/messages']) {
    const res = await partner.get(path, { headers: host, maxRedirects: 0 });
    expect([307, 308], path).toContain(res.status());
    expect(new URL(res.headers()['location'], 'http://x.invalid').pathname, path).toBe('/affiliate');
  }
});
