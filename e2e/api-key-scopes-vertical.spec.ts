import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInViaApi, MARKETING_HOST } from './helpers/auth';

// API key scopes follow the org's product (MKT-6b, src/lib/apiScopes.ts).
//
// A MARKETING org has no internship hiring module, so `hiring:read` (requisitions,
// offers, interview requests) is neither offered nor granted, and a key that
// already stores it — minted before this rule, or in an org whose vertical
// changed — keeps the row but is refused at the door of those routes. The same
// key in an INTERNSHIP org reads them exactly as before.

const PW = 'ApiScopeVertical123!';
const emails: string[] = [];
const orgIds: string[] = [];
let marketingOrgId = '';
let internshipOrgId = '';
let adminEmail = '';

async function storedKey(orgId: string, scopes: string) {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  const row = await prisma.apiKey.create({
    data: { name: `e2e-scope-vertical-${randomBytes(4).toString('hex')}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes, orgId },
  });
  return { id: row.id, headers: { authorization: `Bearer ${raw}` } };
}

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  marketingOrgId = (await prisma.organization.create({
    data: { name: `Scope Marketing ${stamp}`, slug: `scope-mkt-${stamp}`, vertical: 'MARKETING' },
    select: { id: true },
  })).id;
  internshipOrgId = (await prisma.organization.create({
    data: { name: `Scope Internship ${stamp}`, slug: `scope-int-${stamp}`, vertical: 'INTERNSHIP' },
    select: { id: true },
  })).id;
  orgIds.push(marketingOrgId, internshipOrgId);
  await setOrgFeature(marketingOrgId, 'INTEGRATIONS_API', true);
  await setOrgFeature(internshipOrgId, 'INTEGRATIONS_API', true);
  adminEmail = uniqueEmail('scope-mkt-admin');
  emails.push(adminEmail);
  await seedUser(adminEmail, PW, 'ADMIN', 'Scope Marketing Admin', marketingOrgId);
});

test.afterAll(async () => {
  await prisma.webhook.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.apiKey.deleteMany({ where: { orgId: { in: orgIds } } });
  for (const e of emails) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

test('a MARKETING admin is not offered, and cannot create, a key with an internship-only scope', { tag: '@smoke' }, async ({ request }) => {
  const login = await signInViaApi(request, adminEmail, PW, { host: MARKETING_HOST });
  expect(login.ok, `sign-in on the marketing host: ${login.error}`).toBe(true);
  const headers = { 'x-forwarded-host': MARKETING_HOST };

  const list = await request.get('/api/admin/api-keys', { headers });
  expect(list.status()).toBe(200);
  const offered: string[] = (await list.json()).availableScopes;
  expect(offered).toContain('candidates:read');
  expect(offered).not.toContain('hiring:read');

  for (const scopes of [['hiring:read'], ['candidates:read', 'hiring:read']]) {
    const refused = await request.post('/api/admin/api-keys', { headers, data: { name: 'ats', scopes } });
    expect(refused.status(), scopes.join(',')).toBe(400);
    const body = await refused.json();
    expect(body.code).toBe('scope_unavailable');
    expect(body.scopes).toEqual(['hiring:read']);
  }
  expect(await prisma.apiKey.count({ where: { orgId: marketingOrgId, name: 'ats' } })).toBe(0);

  const created = await request.post('/api/admin/api-keys', { headers, data: { name: 'crm-sync', scopes: ['candidates:read'] } });
  expect(created.status()).toBe(201);
});

test('a stored internship-only scope is ignored in MARKETING: the hiring routes refuse, the row keeps it', { tag: '@smoke' }, async ({ request }) => {
  const key = await storedKey(marketingOrgId, 'candidates:read,hiring:read');

  for (const path of ['/api/v1/requisitions', '/api/v1/offers', '/api/v1/interview-requests']) {
    const res = await request.get(path, { headers: key.headers });
    expect(res.status(), path).toBe(403);
    expect((await res.json()).type, path).toBe('capability_unavailable');
  }
  // The rest of the key still works…
  expect((await request.get('/api/v1/candidates', { headers: key.headers })).status()).toBe(200);
  // …and the handshake reports what it actually holds here.
  const me = await (await request.get('/api/v1/me', { headers: key.headers })).json();
  expect(me.data.scopes).toEqual(['candidates:read']);
  // An export of a hiring resource is refused the same way the list is.
  const exp = await request.post('/api/v1/exports', { headers: key.headers, data: { resource: 'requisitions' } });
  expect(exp.status()).toBe(403);
  expect((await exp.json()).type).toBe('insufficient_scope');
  // Ignored, not deleted.
  const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id }, select: { scopes: true } });
  expect(row.scopes).toBe('candidates:read,hiring:read');
});

test('the same key in an INTERNSHIP org reads the hiring routes exactly as before', async ({ request }) => {
  const key = await storedKey(internshipOrgId, 'candidates:read,hiring:read');
  for (const path of ['/api/v1/requisitions', '/api/v1/offers', '/api/v1/interview-requests']) {
    expect((await request.get(path, { headers: key.headers })).status(), path).toBe(200);
  }
  const me = await (await request.get('/api/v1/me', { headers: key.headers })).json();
  expect(me.data.scopes).toEqual(['candidates:read', 'hiring:read']);
});

// Webhook events follow the product too (MKT-6b): a MARKETING org cannot
// subscribe to offer.* / requisition.* / interview events — not from the admin
// form, not over /api/v1/hooks — and a stored subscription naming one keeps its
// row with the event listed apart as ignored.
test('a MARKETING org cannot subscribe to internship hiring events; a stored one is ignored, not deleted', { tag: '@smoke' }, async ({ request }) => {
  const login = await signInViaApi(request, adminEmail, PW, { host: MARKETING_HOST });
  expect(login.ok, `sign-in on the marketing host: ${login.error}`).toBe(true);
  const headers = { 'x-forwarded-host': MARKETING_HOST };

  const list = await request.get('/api/admin/webhooks', { headers });
  expect(list.status()).toBe(200);
  const offered: string[] = (await list.json()).eventTypes;
  expect(offered).toContain('pipeline.stage_change');
  expect(offered.filter((e) => /^(offer|requisition|interview_request|interview_panel)\./.test(e))).toEqual([]);

  const refused = await request.post('/api/admin/webhooks', {
    headers,
    data: { url: 'https://hooks.example.com/in', events: ['pipeline.stage_change', 'offer.sent'] },
  });
  expect(refused.status()).toBe(400);
  expect(await refused.json()).toMatchObject({ code: 'event_unavailable', events: ['offer.sent'] });

  const stored = await prisma.webhook.create({
    data: { url: 'https://hooks.example.com/legacy', events: ['offer.sent', 'pipeline.stage_change'], secret: 'e2e', orgId: marketingOrgId },
  });
  const after = (await (await request.get('/api/admin/webhooks', { headers })).json()).webhooks.find((w: { id: string }) => w.id === stored.id);
  expect(after.events).toEqual(['pipeline.stage_change']);
  expect(after.ignoredEvents).toEqual(['offer.sent']);
  const row = await prisma.webhook.findUniqueOrThrow({ where: { id: stored.id }, select: { events: true } });
  expect(row.events).toEqual(['offer.sent', 'pipeline.stage_change']);

  // The connector's own subscribe endpoint refuses it as an invalid event.
  const key = await storedKey(marketingOrgId, 'hooks:write');
  const sub = await request.post('/api/v1/hooks', { headers: key.headers, data: { targetUrl: 'https://hooks.example.com/zap', event: 'offer.sent' } });
  expect(sub.status()).toBe(422);
  expect(JSON.stringify(await sub.json())).toContain('event_unavailable');
});
