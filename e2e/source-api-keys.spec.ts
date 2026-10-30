import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, setOrgFeature, uniqueEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';

// Self-served SOURCE API keys (#2006) — the company model (company-api-keys.spec)
// over the candidates a referring source owns. A SOURCE owner mints a key bound
// to its own source; the scope ceiling holds (above → 403, never narrowed); the
// /api/v1 door admits the key only where the route filters by that source, so
// it reads its own referred candidates and nobody else's. Another source's key
// is invisible to list and revoke.

const PW = 'SourceKeys123!';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const URL_PATH = '/api/source/integrations/api-keys';
const in30Days = () => new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

let orgId = '';
let sourceBId = '';
let menteeA = '';
let menteeB = '';
const contexts: APIRequestContext[] = [];
const emails = { a: uniqueEmail('skeys-a'), b: uniqueEmail('skeys-b'), none: uniqueEmail('skeys-none'), company: uniqueEmail('skeys-company') };

async function signedIn(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW)).ok).toBe(true);
  return ctx;
}

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `SKeys ${stamp}`, slug: `skeys-${stamp}` } })).id;
  await setOrgFeature(orgId, 'INTEGRATIONS_API', true);
  const [sourceA, sourceB] = await Promise.all(['A', 'B'].map((n) => prisma.source.create({ data: { orgId, name: `SKeys ${n} ${stamp}` } })));
  sourceBId = sourceB.id;
  const [ua, ub, , , ma, mb] = await Promise.all([
    seedUser(emails.a, PW, 'SOURCE', 'SKeys A', orgId),
    seedUser(emails.b, PW, 'SOURCE', 'SKeys B', orgId),
    seedUser(emails.none, PW, 'SOURCE', 'SKeys Unassigned', orgId),
    seedUser(emails.company, PW, 'COMPANY', 'SKeys Company', orgId),
    seedUser(uniqueEmail('skeys-mentee-a'), PW, 'MENTEE', 'SKeys Mentee A', orgId),
    seedUser(uniqueEmail('skeys-mentee-b'), PW, 'MENTEE', 'SKeys Mentee B', orgId),
  ]);
  await prisma.user.update({ where: { id: ua.id }, data: { sourceId: sourceA.id } });
  await prisma.user.update({ where: { id: ub.id }, data: { sourceId: sourceB.id } });
  await prisma.user.update({ where: { id: ma.id }, data: { sourceId: sourceA.id } });
  await prisma.user.update({ where: { id: mb.id }, data: { sourceId: sourceB.id } });
  menteeA = ma.id;
  menteeB = mb.id;
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  if (!orgId) return;
  await prisma.activityLog.deleteMany({ where: { orgId } });
  await prisma.domainEvent.deleteMany({ where: { orgId } });
  await prisma.apiKey.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.source.deleteMany({ where: { orgId } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
});

test('a source owner mints a key for its own referred candidates only; the ceiling and other sources hold at the route', { tag: '@smoke' }, async ({ request }) => {
  const [a, b, none, company] = await Promise.all([signedIn(emails.a), signedIn(emails.b), signedIn(emails.none), signedIn(emails.company)]);

  // Not a source owner: refused by the handler.
  expect((await company.post(URL_PATH, { data: { name: 'x', scopes: ['candidates:read'], expiresAt: in30Days() } })).status()).toBe(403);
  const unassigned = await none.post(URL_PATH, { data: { name: 'x', scopes: ['candidates:read'], expiresAt: in30Days() } });
  expect(unassigned.status()).toBe(403);
  expect((await unassigned.json()).code).toBe('source_not_assigned');

  // Above the ceiling: 403 naming the scope, and nothing minted; never permanent.
  const above = await a.post(URL_PATH, { data: { name: 'too much', scopes: ['candidates:read', 'hiring:read'], expiresAt: in30Days() } });
  expect(above.status()).toBe(403);
  expect(await above.json()).toMatchObject({ code: 'scope_above_ceiling', scopes: ['hiring:read'] });
  expect((await a.post(URL_PATH, { data: { name: 'forever', scopes: ['candidates:read'] } })).status()).toBe(400);
  expect(await prisma.apiKey.count({ where: { orgId } })).toBe(0);

  const minted = await a.post(URL_PATH, { data: { name: 'CRM sync', scopes: ['candidates:read'], expiresAt: in30Days() } });
  expect(minted.status()).toBe(201);
  const { id: keyId, key: raw } = await minted.json();
  const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });
  expect(row.sourceId).not.toBeNull();
  expect(row.companyId).toBeNull();
  expect(await prisma.activityLog.count({ where: { action: 'apikey.created', targetId: keyId, level: 'WARNING' } })).toBe(1);

  // Its own referred candidate, never another source's — list and by id.
  const auth = { authorization: `Bearer ${raw}` };
  const list = await request.get('/api/v1/candidates', { headers: auth });
  expect(list.status()).toBe(200);
  expect(((await list.json()).data as { id: string }[]).map((r) => r.id)).toEqual([menteeA]);
  expect((await request.get(`/api/v1/candidates/${menteeA}`, { headers: auth })).status()).toBe(200);
  expect((await request.get(`/api/v1/candidates/${menteeB}`, { headers: auth })).status()).toBe(404);
  expect((await request.get('/api/v1/me', { headers: auth })).status()).toBe(200);
  // A route that does not filter by source refuses it, even one its scope
  // would cover (the export reads the whole org).
  const exp = await request.post('/api/v1/exports', { headers: auth, data: { resource: 'candidates' } });
  expect(exp.status()).toBe(403);
  expect((await exp.json()).type).toBe('source_key_not_allowed');

  // Source B neither sees nor revokes A's key.
  expect(((await (await b.get(URL_PATH)).json()).keys as unknown[]).length).toBe(0);
  expect((await b.delete(`${URL_PATH}?id=${keyId}`)).status()).toBe(404);
  expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } })).revokedAt).toBeNull();

  // A sees its key; revoking it closes the door.
  expect(((await (await a.get(URL_PATH)).json()).keys as { id: string }[]).map((k) => k.id)).toEqual([keyId]);
  expect((await a.delete(`${URL_PATH}?id=${keyId}`)).status()).toBe(200);
  expect(await prisma.activityLog.count({ where: { action: 'apikey.revoked', targetId: keyId, level: 'WARNING' } })).toBe(1);
  expect((await request.get('/api/v1/candidates', { headers: auth })).status()).toBe(401);
});

test('the source integrations page creates a key, shows it once and revokes it', async ({ page }) => {
  expect((await signInViaApi(page.request, emails.b, PW)).ok).toBe(true);
  await gotoSettled(page, '/source/integrations');
  await page.getByTestId('company-key-name').fill('Referral bridge');
  await page.getByTestId('company-key-create').click();
  await expect(page.getByTestId('company-key-fresh').locator('code')).toHaveText(/^\S{20,}$/);
  const row = await prisma.apiKey.findFirstOrThrow({ where: { orgId, name: 'Referral bridge' } });
  expect(row.sourceId).toBe(sourceBId);
  page.once('dialog', (d) => d.accept());
  await page.getByTestId(`company-key-revoke-${row.id}`).click();
  await expect(page.getByTestId(`company-key-revoke-${row.id}`)).toHaveCount(0);
  expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } })).revokedAt).not.toBeNull();
});
