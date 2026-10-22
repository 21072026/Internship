import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';
import { prisma as appPrisma } from '../src/lib/prisma';
import { saveContract } from '../src/lib/affiliateContract';

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
  await seedUser(orphanEmail, PW, 'AFFILIATE', 'No Partner Record', { orgId });
  await seedUser(leadEmail, PW, 'MENTEE', 'Marketing Lead', { orgId });
  await seedUser(strayEmail, PW, 'AFFILIATE', 'Internship Affiliate');
  await prisma.affiliatePartner.create({ data: { orgId, userId: partnerUser.id, code: 'gate-1', displayName: 'Gate Partner' } });
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  if (orgId) {
    await prisma.affiliateContractAcceptance.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId } }).catch(() => {});
  }
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
  expect(await saveContract(orgId, { en: 'Synthetic terms v1', de: 'Synthetische Bedingungen v1' })).toEqual({ changed: true, version: 1 });

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
  expect(await saveContract(orgId, { de: 'Synthetische Bedingungen v1', en: 'Synthetic terms v1' })).toEqual({ changed: false, version: 1 });
  expect((await partner.get('/api/affiliate/me', { headers: host })).status()).toBe(200);

  // A changed text: version 2, the partner is held again.
  expect(await saveContract(orgId, { en: 'Synthetic terms v2', de: 'Synthetische Bedingungen v1' })).toEqual({ changed: true, version: 2 });
  expect((await partner.get('/api/affiliate/me', { headers: host })).status()).toBe(409);
});
