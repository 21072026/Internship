import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, setOrgFeature, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Self-served company API keys (#2006). A COMPANY owner mints a key bound to
// their own company; its scopes never exceed the company ceiling (above → 403,
// never narrowed); the /api/v1 door admits it only where the route filters by
// that company, so it reads its own requisitions and nothing of another
// company or of the org at large. Another company's key is invisible to list
// and revoke. Everything here is decided by the route handler, not a menu.

const PW = 'CompanyKeys123!';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const in30Days = () => new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

let orgId = '';
const contexts: APIRequestContext[] = [];
const emails = { a: uniqueEmail('ckeys-a'), b: uniqueEmail('ckeys-b'), none: uniqueEmail('ckeys-none'), mentor: uniqueEmail('ckeys-mentor') };
let reqA = '';
let reqB = '';
let companyBId = '';
let a: APIRequestContext;
let b: APIRequestContext;
let none: APIRequestContext;
let mentor: APIRequestContext;

async function signedIn(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW)).ok).toBe(true);
  return ctx;
}

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `CKeys ${stamp}`, slug: `ckeys-${stamp}` } });
  orgId = org.id;
  await setOrgFeature(orgId, 'INTEGRATIONS_API', true);
  const [companyA, companyB] = await Promise.all(
    ['A', 'B'].map((n) => prisma.company.create({ data: { orgId, name: `CKeys ${n} ${stamp}` } })),
  );
  const users = await Promise.all([
    seedUser(emails.a, PW, 'COMPANY', 'CKeys A', orgId),
    seedUser(emails.b, PW, 'COMPANY', 'CKeys B', orgId),
    seedUser(emails.none, PW, 'COMPANY', 'CKeys Unassigned', orgId),
    seedUser(emails.mentor, PW, 'MENTOR', 'CKeys Mentor', orgId),
  ]);
  await prisma.user.update({ where: { id: users[0].id }, data: { companyId: companyA.id } });
  await prisma.user.update({ where: { id: users[1].id }, data: { companyId: companyB.id } });
  const mkReq = (companyId: string, title: string) =>
    prisma.requisition.create({ data: { orgId, companyId, title, status: 'OPEN', openings: 1, requiredSkills: [] }, select: { id: true } });
  companyBId = companyB.id;
  reqA = (await mkReq(companyA.id, 'CKeys role A')).id;
  reqB = (await mkReq(companyB.id, 'CKeys role B')).id;
  [a, b, none, mentor] = await Promise.all([signedIn(emails.a), signedIn(emails.b), signedIn(emails.none), signedIn(emails.mentor)]);
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  if (!orgId) return;
  await prisma.activityLog.deleteMany({ where: { orgId } });
  await prisma.apiKey.deleteMany({ where: { orgId } });
  await prisma.requisition.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.company.deleteMany({ where: { orgId } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
});

test('a company owner mints a key for its own hiring records only; the ceiling and other companies hold at the route', { tag: '@smoke' }, async ({ request }) => {
  const url = '/api/company/integrations/api-keys';

  // Not a company owner: refused by the handler.
  expect((await mentor.post(url, { data: { name: 'x', scopes: ['hiring:read'], expiresAt: in30Days() } })).status()).toBe(403);
  const unassigned = await none.post(url, { data: { name: 'x', scopes: ['hiring:read'], expiresAt: in30Days() } });
  expect(unassigned.status()).toBe(403);
  expect((await unassigned.json()).code).toBe('company_not_assigned');

  // Above the ceiling: 403 naming the scope, and nothing minted.
  const above = await a.post(url, { data: { name: 'too much', scopes: ['hiring:read', 'candidates:read'], expiresAt: in30Days() } });
  expect(above.status()).toBe(403);
  expect(await above.json()).toMatchObject({ code: 'scope_above_ceiling', scopes: ['candidates:read'] });
  // A self-served key is never permanent.
  expect((await a.post(url, { data: { name: 'forever', scopes: ['hiring:read'] } })).status()).toBe(400);
  expect(await prisma.apiKey.count({ where: { orgId } })).toBe(0);

  const minted = await a.post(url, { data: { name: 'ATS sync', scopes: ['hiring:read'], expiresAt: in30Days() } });
  expect(minted.status()).toBe(201);
  const { id: keyId, key: raw } = await minted.json();
  expect(raw).toBeTruthy();
  const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });
  expect(row.companyId).not.toBeNull();
  expect(row.orgId).toBe(orgId);
  expect(await prisma.activityLog.count({ where: { action: 'apikey.created', targetId: keyId, level: 'WARNING' } })).toBe(1);

  // The key reads its own company's requisitions, never another company's —
  // not through the list, not by id, not by asking for the other company.
  const auth = { authorization: `Bearer ${raw}` };
  const list = await request.get('/api/v1/requisitions', { headers: auth });
  expect(list.status()).toBe(200);
  expect(((await list.json()).data as { id: string }[]).map((r) => r.id)).toEqual([reqA]);
  expect((await request.get(`/api/v1/requisitions/${reqB}`, { headers: auth })).status()).toBe(404);
  expect((await request.get(`/api/v1/requisitions/${reqA}`, { headers: auth })).status()).toBe(200);
  const asOther = await request.get(`/api/v1/requisitions?companyId=${companyBId}`, { headers: auth });
  expect((await asOther.json()).data).toEqual([]);
  // A route that does not filter by company refuses it outright, even one its
  // scope would cover (the export reads the whole org).
  const exp = await request.post('/api/v1/exports', { headers: auth, data: { resource: 'requisitions' } });
  expect(exp.status()).toBe(403);
  expect((await exp.json()).type).toBe('company_key_not_allowed');

  // Company B neither sees nor revokes A's key.
  expect(((await (await b.get(url)).json()).keys as unknown[]).length).toBe(0);
  expect((await b.delete(`${url}?id=${keyId}`)).status()).toBe(404);
  expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } })).revokedAt).toBeNull();

  // A sees its key; revoking it closes the door.
  const own = (await (await a.get(url)).json()).keys as { id: string; status: string }[];
  expect(own.map((k) => k.id)).toEqual([keyId]);
  expect((await a.delete(`${url}?id=${keyId}`)).status()).toBe(200);
  expect(await prisma.activityLog.count({ where: { action: 'apikey.revoked', targetId: keyId, level: 'WARNING' } })).toBe(1);
  expect((await request.get('/api/v1/requisitions', { headers: auth })).status()).toBe(401);
});
