import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { V1_SUPPORT_PROBES } from './fixtures/authz-matrix';

// GET /api/v1/support/reports[/id][/screenshot] (src/lib/api/v1Support.ts): the
// org's in-app bug reports, read-only, for a key holding `support:read`. Masked
// by the one masking path (src/lib/feedbackContext.ts) on the way out, every
// read audited (key + report ids), the screenshot behind its own scope.

const PW = 'V1Support123!';
const STAMP = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const emails: string[] = [];
const orgIds: string[] = [];
const ids: Record<string, string> = {};
// A tiny valid PNG (1×1).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function key(orgId: string, scopes: string) {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  const row = await prisma.apiKey.create({
    data: { name: `e2e-support-${randomBytes(4).toString('hex')}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes, orgId },
  });
  return { id: row.id, headers: { authorization: `Bearer ${raw}` } };
}

async function report(label: string, orgId: string, userId: string, withScreenshot: boolean) {
  const row = await prisma.supportReport.create({
    data: {
      orgId,
      userId,
      type: 'BUG',
      description: `The save button fails for ${label}; mail me at someone-${label}@acme.example, token=abc123secret`,
      url: `https://app.example.test/sales/leads/x?token=abc123secret&page=2`,
      appVersion: '9.9.9-e2e',
      env: 'test',
      userAgent: 'e2e',
      viewport: '1280x720',
      contactAllowed: true,
      context: {
        consoleErrors: [{ kind: 'console', message: `boom for user-${label}@acme.example`, at: new Date().toISOString() }],
        failedRequests: [{ method: 'PUT', url: 'https://app.example.test/api/x?access_token=zzz', status: 500, durationMs: 12, requestId: `req-${label}-1`, at: new Date().toISOString() }],
      },
      ...(withScreenshot ? { files: { create: { kind: 'SCREENSHOT', filename: 'shot.png', contentType: 'image/png', size: PNG.length, data: PNG } } } : {}),
    },
  });
  ids[label] = row.id;
}

test.beforeAll(async () => {
  for (const label of ['a', 'b']) {
    const id = (await prisma.organization.create({ data: { name: `Support API ${label} ${STAMP}`, slug: `support-api-${label}-${STAMP}`, vertical: 'INTERNSHIP' } })).id;
    orgIds.push(id);
    ids[`org-${label}`] = id;
    await setOrgFeature(id, 'INTEGRATIONS_API', true);
    const email = uniqueEmail(`support-api-${label}`);
    emails.push(email);
    ids[`user-${label}`] = (await seedUser(email, PW, label === 'a' ? 'ADMIN' : 'MENTOR', `Reporter ${label} ${STAMP}`, id)).id;
    if (label === 'a') ids.adminEmail = email;
  }
  await report('a1', ids['org-a'], ids['user-a'], true);
  await report('a2', ids['org-a'], ids['user-a'], false);
  await report('b1', ids['org-b'], ids['user-b'], true);
});

test.afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.supportReport.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.apiKey.deleteMany({ where: { orgId: { in: orgIds } } });
  for (const e of emails) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

test('a support:read key lists and reads its org’s reports, masked, and every read is audited', { tag: '@smoke' }, async ({ request }) => {
  const k = await key(ids['org-a'], 'support:read');
  const list = await request.get('/api/v1/support/reports?limit=500', { headers: k.headers });
  expect(list.status()).toBe(200);
  const text = await list.text();
  const body = JSON.parse(text);
  const listed = (body.data as { id: string }[]).map((r) => r.id);
  expect(listed.sort()).toEqual([ids.a1, ids.a2].sort());
  expect(listed).not.toContain(ids.b1);
  expect(body.page).toMatchObject({ hasMore: false });

  // Masked by the one path: no address, no token, no query value in any field.
  for (const secret of ['@acme.example', 'abc123secret', 'access_token=zzz']) expect(text, secret).not.toContain(secret);
  const r = body.data.find((x: { id: string }) => x.id === ids.a1);
  expect(r).toMatchObject({ type: 'BUG', status: 'NEW', reporter: { name: `Reporter a ${STAMP}`, role: 'ADMIN' }, appVersion: '9.9.9-e2e', requestIds: ['req-a1-1'], hasScreenshot: true });
  expect(r.description).toContain('The save button fails for a1');
  expect(r.reporter).not.toHaveProperty('email');
  expect(r).not.toHaveProperty('userAgent');
  expect(r.failedRequests[0]).toMatchObject({ method: 'PUT', status: 500 });

  const one = await request.get(`/api/v1/support/reports/${ids.a2}`, { headers: k.headers });
  expect(one.status()).toBe(200);
  expect((await one.json()).data).toMatchObject({ id: ids.a2, hasScreenshot: false });

  // The filters, and `since` as an alias of updatedSince.
  const resolved = await request.get('/api/v1/support/reports?status=RESOLVED', { headers: k.headers });
  expect((await resolved.json()).data).toEqual([]);
  const future = await request.get(`/api/v1/support/reports?since=${encodeURIComponent('2999-01-01T00:00:00Z')}`, { headers: k.headers });
  expect((await future.json()).data).toEqual([]);
  expect((await request.get('/api/v1/support/reports?status=OPEN', { headers: k.headers })).status()).toBe(400);

  // Audit: who (the key), what, which reports — ids only, never the text.
  const rows = await prisma.auditLog.findMany({ where: { orgId: ids['org-a'], actorId: `api_key:${k.id}` } });
  expect(rows.map((x) => x.action)).toEqual(expect.arrayContaining(['API_SUPPORT_REPORT_LIST', 'API_SUPPORT_REPORT_READ']));
  const read = rows.find((x) => x.action === 'API_SUPPORT_REPORT_READ');
  expect(read?.targetId).toBe(ids.a2);
  for (const x of rows) expect(x.detail ?? '').not.toContain('save button');
});

test('a key without support:read is refused; another org’s report is a 404', { tag: '@smoke' }, async ({ request }) => {
  const other = await key(ids['org-a'], 'candidates:read');
  for (const path of ['/api/v1/support/reports', `/api/v1/support/reports/${ids.a1}`, `/api/v1/support/reports/${ids.a1}/screenshot`]) {
    const res = await request.get(path, { headers: other.headers });
    expect(res.status(), path).toBe(403);
    expect((await res.json()).type, path).toBe('insufficient_scope');
  }
  const k = await key(ids['org-a'], 'support:read,support:read_screenshots');
  for (const path of [`/api/v1/support/reports/${ids.b1}`, `/api/v1/support/reports/${ids.b1}/screenshot`, '/api/v1/support/reports/does-not-exist']) {
    expect((await request.get(path, { headers: k.headers })).status(), path).toBe(404);
  }
  // No key at all.
  expect((await request.get('/api/v1/support/reports')).status()).toBe(401);
});

test('the screenshot needs support:read_screenshots on top of support:read', { tag: '@smoke' }, async ({ request }) => {
  const readOnly = await key(ids['org-a'], 'support:read');
  const refused = await request.get(`/api/v1/support/reports/${ids.a1}/screenshot`, { headers: readOnly.headers });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).scope).toBe('support:read_screenshots');
  // The screenshot scope alone does not read either.
  const shotsOnly = await key(ids['org-a'], 'support:read_screenshots');
  expect((await request.get(`/api/v1/support/reports/${ids.a1}/screenshot`, { headers: shotsOnly.headers })).status()).toBe(403);

  const both = await key(ids['org-a'], 'support:read,support:read_screenshots');
  const shot = await request.get(`/api/v1/support/reports/${ids.a1}/screenshot`, { headers: both.headers });
  expect(shot.status()).toBe(200);
  expect(shot.headers()['content-type']).toBe('image/png');
  expect(Buffer.compare(await shot.body(), PNG)).toBe(0);
  // A report without one is a 404.
  expect((await request.get(`/api/v1/support/reports/${ids.a2}/screenshot`, { headers: both.headers })).status()).toBe(404);
  expect(await prisma.auditLog.count({ where: { actorId: `api_key:${both.id}`, action: 'API_SUPPORT_REPORT_SCREENSHOT', targetId: ids.a1 } })).toBe(1);
});

test('the admin is offered the support scopes and can mint a key with them', async ({ request }) => {
  const login = await signInViaApi(request, ids.adminEmail, PW);
  expect(login.ok, `sign-in: ${login.error}`).toBe(true);
  const list = await request.get('/api/admin/api-keys');
  expect(list.status()).toBe(200);
  expect((await list.json()).availableScopes).toEqual(expect.arrayContaining(['support:read', 'support:read_screenshots']));
});

test('the scope × endpoint matrix (authz-matrix V1_SUPPORT_PROBES)', { tag: '@smoke' }, async ({ request }) => {
  const fill = (path: string) => path.replace(':ownShot', ids.a1).replace(':own', ids.a2).replace(':foreign', ids.b1);
  for (const probe of V1_SUPPORT_PROBES) {
    const headers = probe.scopes ? (await key(ids['org-a'], probe.scopes)).headers : {};
    const res = await request.get(fill(probe.path), { headers });
    expect(res.status(), `${probe.scopes || '(none)'} ${probe.path} — ${probe.why}`).toBe(probe.expect);
  }
});
