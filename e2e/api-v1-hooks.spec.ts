import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, setOrgFeature } from './helpers/db';
import { liveSubscriptionsWhere } from '@/lib/webhooks';

// REST-hook subscriptions and the connector handshake (#2002): a key manages
// its OWN subscriptions — never another key's, never an admin's, never another
// tenant's — and GET /api/v1/me tells a key what it is and nothing else.
//
// API-only. The target is a literal public address so the SSRF guard needs no
// DNS; nothing is delivered to it (no event fires in this spec). "Receive" is
// asserted on the query delivery uses, liveSubscriptionsWhere().

// A literal public address: passes the guard, never resolved.
const TARGET = 'https://93.184.215.14/hooks/e2e';

async function seedOrg(label: string) {
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `${label} ${stamp}`, slug: `v1-hooks-${label.toLowerCase()}-${stamp}` } });
  await setOrgFeature(org.id, 'INTEGRATIONS_API', true);
  return org.id;
}

async function mintKey(orgId: string, scopes: string) {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  const key = await prisma.apiKey.create({
    data: { name: `e2e-v1-hooks-${randomBytes(4).toString('hex')}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes, orgId },
  });
  return { id: key.id, headers: { authorization: `Bearer ${raw}` } };
}

let orgA: string;
let orgB: string;

test.beforeAll(async () => {
  orgA = await seedOrg('A');
  orgB = await seedOrg('B');
});

test.afterAll(async () => {
  const orgIds = [orgA, orgB].filter(Boolean);
  await prisma.webhook.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.apiKey.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
});

test('a key subscribes, lists and unsubscribes only its own hooks; every other id is a 404', { tag: '@smoke' }, async ({ request }) => {
  const a1 = await mintKey(orgA, 'hooks:write');
  const a2 = await mintKey(orgA, 'hooks:write');
  const b = await mintKey(orgB, 'hooks:write');
  const reader = await mintKey(orgA, 'candidates:read');

  // Scope first: a key without hooks:write cannot subscribe.
  expect((await request.post('/api/v1/hooks', { headers: reader.headers, data: { targetUrl: TARGET, event: 'pipeline.stage_change' } })).status()).toBe(403);

  // The SSRF guard of the admin form, on the key-owned door too.
  for (const targetUrl of ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'http://93.184.215.14/plain', 'https://localhost/x']) {
    const refused = await request.post('/api/v1/hooks', { headers: a1.headers, data: { targetUrl, event: 'pipeline.stage_change' } });
    expect(refused.status(), targetUrl).toBe(422);
    expect((await refused.json()).errors[0]).toMatchObject({ path: 'targetUrl' });
  }

  const created = await request.post('/api/v1/hooks', { headers: a1.headers, data: { targetUrl: TARGET, event: 'pipeline.stage_change' } });
  expect(created.status()).toBe(201);
  const hook = (await created.json()).data;
  expect(hook).toMatchObject({ targetUrl: TARGET, event: 'pipeline.stage_change', active: true });
  expect(hook.secret).toMatch(/^[0-9a-f]{48}$/);
  const row = await prisma.webhook.findUniqueOrThrow({ where: { id: hook.id } });
  expect(row).toMatchObject({ orgId: orgA, apiKeyId: a1.id, source: 'api', secret: hook.secret });

  // An admin-created hook in the same org: no owner key.
  const adminHook = await prisma.webhook.create({ data: { orgId: orgA, url: TARGET, secret: 'admin-secret', events: ['interaction.logged'] } });

  // Listing: the key's own, without secrets.
  const listA1 = (await (await request.get('/api/v1/hooks', { headers: a1.headers })).json()).data as { id: string; secret?: string }[];
  expect(listA1.map((h) => h.id)).toEqual([hook.id]);
  expect(listA1[0].secret).toBeUndefined();
  expect((await (await request.get('/api/v1/hooks', { headers: a2.headers })).json()).data).toEqual([]);
  expect((await (await request.get('/api/v1/hooks', { headers: b.headers })).json()).data).toEqual([]);

  // Another key of the same org, another org, and an admin hook: all 404, nothing deleted.
  for (const [key, id] of [[a2, hook.id], [b, hook.id], [a1, adminHook.id]] as const) {
    const res = await request.delete(`/api/v1/hooks/${id}`, { headers: key.headers });
    expect(res.status()).toBe(404);
    expect(await res.json()).toMatchObject({ type: 'not_found' });
  }
  expect(await prisma.webhook.count({ where: { id: { in: [hook.id, adminHook.id] } } })).toBe(2);

  // Delivery reaches both live subscriptions of the org …
  const live = async () => (await prisma.webhook.findMany({ where: liveSubscriptionsWhere(orgA), select: { id: true } })).map((h) => h.id).sort();
  expect(await live()).toEqual([adminHook.id, hook.id].sort());
  // … and stops for the key's the moment the key is revoked; the admin's is untouched.
  await prisma.apiKey.update({ where: { id: a1.id }, data: { revokedAt: new Date() } });
  expect(await live()).toEqual([adminHook.id]);
  await prisma.apiKey.update({ where: { id: a1.id }, data: { revokedAt: null } });

  // The owner unsubscribes.
  const gone = await request.delete(`/api/v1/hooks/${hook.id}`, { headers: a1.headers });
  expect(gone.status()).toBe(200);
  expect((await gone.json()).data).toEqual({ id: hook.id, deleted: true });
  expect(await prisma.webhook.count({ where: { id: hook.id } })).toBe(0);
  expect(await prisma.webhook.count({ where: { id: adminHook.id } })).toBe(1);
  expect(await prisma.activityLog.count({ where: { action: { in: ['api.hook.subscribe', 'api.hook.unsubscribe'] }, targetId: hook.id } })).toBe(2);

  // The per-key cap.
  await prisma.webhook.createMany({
    data: Array.from({ length: 25 }, (_, i) => ({ orgId: orgA, apiKeyId: a2.id, source: 'api', url: `${TARGET}/${i}`, secret: `s${i}`, events: ['pipeline.stage_change'] })),
  });
  const capped = await request.post('/api/v1/hooks', { headers: a2.headers, data: { targetUrl: TARGET, event: 'pipeline.stage_change' } });
  expect(capped.status()).toBe(409);
  expect(await capped.json()).toMatchObject({ type: 'limit_reached', limit: 25 });
});

test('GET /api/v1/me answers any live key with its org, scopes, expiry and limits — and no people', { tag: '@smoke' }, async ({ request }) => {
  expect((await request.get('/api/v1/me')).status()).toBe(401);

  const expiresAt = new Date(Date.now() + 30 * 86_400_000);
  const key = await mintKey(orgA, 'candidates:read');
  await prisma.apiKey.update({ where: { id: key.id }, data: { expiresAt, quotaPeriod: 'day', quotaLimit: 1000 } });
  const res = await request.get('/api/v1/me', { headers: key.headers });
  expect(res.status()).toBe(200);
  const me = (await res.json()).data;
  expect(me).toMatchObject({
    keyId: key.id,
    orgId: orgA,
    scopes: ['candidates:read'],
    expiresAt: expiresAt.toISOString(),
    quota: { period: 'day', limit: 1000 },
  });
  expect(me.rateLimit).toEqual({ limit: 120, remaining: expect.any(Number), resetAt: expect.any(String) });
  expect(Object.keys(me).sort()).toEqual(['expiresAt', 'keyId', 'orgId', 'orgName', 'quota', 'rateLimit', 'scopes']);

  // A revoked key is not "live": the same 401 as an unknown one.
  await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
  expect((await request.get('/api/v1/me', { headers: key.headers })).status()).toBe(401);

  // The plan still applies: an org without the public API gets feature_locked.
  const unentitled = await mintKey(orgB, 'candidates:read');
  await prisma.orgEntitlement.deleteMany({ where: { orgId: orgB } });
  try {
    const locked = await request.get('/api/v1/me', { headers: unentitled.headers });
    expect(locked.status()).toBe(403);
    expect(await locked.json()).toMatchObject({ type: 'feature_locked' });
  } finally {
    await setOrgFeature(orgB, 'INTEGRATIONS_API', true);
  }
});
