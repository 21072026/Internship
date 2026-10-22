import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { gunzipSync } from 'zlib';
import { prisma, setOrgFeature } from './helpers/db';
import { seedTwoTenants, type TwoTenants } from './helpers/tenants';
import { signDownload } from '@/lib/api/v1Exports';

// Async exports of /api/v1 (#3002): the file is written by the `api.export`
// job on the worker, never inside the request; it holds exactly what the list
// would — the key's org only, the note body only with interactions:read_notes —
// and it is fetched through a signed link that expires, is refused when
// tampered with, and dies with the key that made it. Another key's or another
// tenant's export is a 404.
//
// API-only. Two symmetric tenants (helpers/tenants.ts) plus one interaction
// each. The worker ticks every 5s in the dev server (src/instrumentation.ts);
// a READY export is polled for.

const SECRET_NOTE = 'confidential export note';

async function mintKey(orgId: string, scopes: string) {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  const key = await prisma.apiKey.create({
    data: { name: `e2e-v1-exports-${randomBytes(4).toString('hex')}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes, orgId },
  });
  return { id: key.id, headers: { authorization: `Bearer ${raw}` } };
}

async function waitReady(request: APIRequestContext, id: string, headers: Record<string, string>) {
  let body: { data: { status: string; downloadUrl?: string; rowCount?: number; error?: string | null } } | undefined;
  await expect
    .poll(
      async () => {
        body = await (await request.get(`/api/v1/exports/${id}`, { headers })).json();
        return body?.data?.status;
      },
      { timeout: 45_000, intervals: [1000] },
    )
    .toMatch(/READY|FAILED/);
  return body!.data;
}

async function download(request: APIRequestContext, url: string) {
  const res = await request.get(url);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/gzip');
  const text = gunzipSync(await res.body()).toString('utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

let tenants: TwoTenants;
const interactions: Record<'A' | 'B', string> = { A: '', B: '' };

test.beforeAll(async () => {
  tenants = await seedTwoTenants();
  for (const [label, t] of [['A', tenants.orgA], ['B', tenants.orgB]] as const) {
    await setOrgFeature(t.org.id, 'INTEGRATIONS_API', true);
    const row = await prisma.interactionLog.create({ data: { relationId: t.relation.id, date: new Date(), type: 'Meeting', notes: `${SECRET_NOTE} ${label}` } });
    interactions[label] = row.id;
  }
});

test.afterAll(async () => {
  const orgIds = tenants?.orgIds ?? [];
  await prisma.job.deleteMany({ where: { name: 'api.export', orgId: { in: orgIds } } });
  await prisma.apiExport.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds }, action: { startsWith: 'api.export' } } });
  await prisma.apiKey.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: orgIds } } });
  await tenants?.cleanup();
});

test('an export runs on the queue and holds the key’s org only, notes only with their scope', { tag: '@smoke' }, async ({ request }) => {
  const plain = await mintKey(tenants.orgA.org.id, 'interactions:read');
  const withNotes = await mintKey(tenants.orgA.org.id, 'interactions:read,interactions:read_notes');

  const created = await request.post('/api/v1/exports', { headers: plain.headers, data: { resource: 'interactions' } });
  expect(created.status()).toBe(202);
  const queued = (await created.json()).data;
  expect(queued).toMatchObject({ resource: 'interactions', status: 'PENDING', includesNotes: false });
  expect(queued.downloadUrl).toBeUndefined();
  expect(created.headers()['location']).toBe(`/api/v1/exports/${queued.id}`);
  // On the queue, not inline: a job names the export, and the org.
  const job = await prisma.job.findFirst({ where: { name: 'api.export', orgId: tenants.orgA.org.id, idempotencyKey: `api.export:${queued.id}` } });
  expect(job?.payload).toEqual({ exportId: queued.id });

  const ready = await waitReady(request, queued.id, plain.headers);
  expect(ready).toMatchObject({ status: 'READY', rowCount: 1, error: null });
  const rows = await download(request, ready.downloadUrl!);
  expect(rows.map((r) => r.id)).toEqual([interactions.A]);
  expect(rows[0]).not.toHaveProperty('notes');
  expect(JSON.stringify(rows)).not.toContain(SECRET_NOTE);

  const noted = (await (await request.post('/api/v1/exports', { headers: withNotes.headers, data: { resource: 'interactions' } })).json()).data;
  expect(noted.includesNotes).toBe(true);
  const notedReady = await waitReady(request, noted.id, withNotes.headers);
  const notedRows = await download(request, notedReady.downloadUrl!);
  expect(notedRows.map((r) => r.notes)).toEqual([`${SECRET_NOTE} A`]);
});

test('exports are the making key’s alone; links are signed, expire and die with the key', { tag: '@smoke' }, async ({ request }) => {
  const owner = await mintKey(tenants.orgA.org.id, 'interactions:read,candidates:read');
  const sibling = await mintKey(tenants.orgA.org.id, 'interactions:read');
  const other = await mintKey(tenants.orgB.org.id, 'interactions:read');

  // The resource's own read scope, checked before anything is queued.
  const refused = await request.post('/api/v1/exports', { headers: sibling.headers, data: { resource: 'candidates' } });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).type).toBe('insufficient_scope');
  expect((await request.post('/api/v1/exports', { headers: owner.headers, data: { resource: 'users' } })).status()).toBe(422);

  const id = (await (await request.post('/api/v1/exports', { headers: owner.headers, data: { resource: 'interactions' } })).json()).data.id as string;
  const ready = await waitReady(request, id, owner.headers);
  expect(ready.status).toBe('READY');

  // Another key of the same org and another tenant's key: a plain 404.
  for (const k of [sibling, other]) {
    const res = await request.get(`/api/v1/exports/${id}`, { headers: k.headers });
    expect(res.status()).toBe(404);
    expect((await res.json()).type).toBe('not_found');
  }

  const url = new URL(ready.downloadUrl!);
  const path = `${url.pathname}`;
  const expires = url.searchParams.get('expires')!;
  const sig = url.searchParams.get('sig')!;
  // Tampered: another signature, another expiry, another id.
  const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
  for (const bad of [
    `${path}?expires=${expires}&sig=${flipped}`,
    `${path}?expires=${Number(expires) + 60_000}&sig=${sig}`,
    `/api/exports/${tenants.orgB.relation.id}/download?expires=${expires}&sig=${sig}`,
    path,
  ]) {
    const res = await request.get(bad);
    expect(res.status(), bad).toBe(403);
    expect((await res.json()).type).toBe('invalid_link');
  }
  // Expired: a correctly signed link whose instant has passed.
  const past = signDownload(id, Date.now() - 1000);
  expect((await request.get(`${path}?expires=${past.expires}&sig=${past.sig}`)).status()).toBe(403);
  // The genuine link works…
  expect((await request.get(`${path}?expires=${expires}&sig=${sig}`)).status()).toBe(200);
  // …until the key that made it is revoked.
  await prisma.apiKey.update({ where: { id: owner.id }, data: { revokedAt: new Date() } });
  const dead = await request.get(`${path}?expires=${expires}&sig=${sig}`);
  expect(dead.status()).toBe(403);
  expect((await dead.json()).type).toBe('invalid_link');
});

test('a key may have only a few exports in flight', async ({ request }) => {
  const key = await mintKey(tenants.orgB.org.id, 'interactions:read');
  // Rows with no job behind them stay PENDING: the cap is reached without racing the worker.
  await prisma.apiExport.createMany({
    data: [1, 2, 3].map(() => ({ orgId: tenants.orgB.org.id, apiKeyId: key.id, resource: 'interactions', expiresAt: new Date(Date.now() + 3600_000) })),
  });
  const res = await request.post('/api/v1/exports', { headers: key.headers, data: { resource: 'interactions' } });
  expect(res.status()).toBe(409);
  expect((await res.json()).type).toBe('limit_reached');
});
