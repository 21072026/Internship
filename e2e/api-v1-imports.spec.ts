import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, setOrgFeature } from './helpers/db';
import { seedTwoTenants, type TwoTenants } from './helpers/tenants';

// Queued bulk candidate import on /api/v1 (#3015): the rows are created by the
// `api.import.candidates` job on the worker, never inside the request; every
// row is judged by the rules of the single POST /candidates and reported on
// its own (CREATE, SKIP with the duplicate, ERROR with the field); a dry run
// writes nothing; and the report is the queuing key's alone — another key's or
// another tenant's id is a 404.
//
// API-only. Two symmetric tenants (helpers/tenants.ts). The worker ticks every
// 5s in the dev server (src/instrumentation.ts); a DONE import is polled for.

async function mintKey(orgId: string, scopes: string) {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  const key = await prisma.apiKey.create({
    data: { name: `e2e-v1-imports-${randomBytes(4).toString('hex')}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes, orgId },
  });
  return { id: key.id, headers: { authorization: `Bearer ${raw}` } };
}

type Report = { status: string; counts?: Record<string, number>; rows?: { row: number; key: string; status: string; reason?: string; id?: string; matches?: { id: string }[] }[] };

async function waitDone(request: APIRequestContext, id: string, headers: Record<string, string>): Promise<Report> {
  let data: Report | undefined;
  await expect
    .poll(
      async () => {
        data = (await (await request.get(`/api/v1/imports/${id}`, { headers })).json()).data;
        return data?.status;
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toMatch(/DONE|FAILED/);
  return data!;
}

const unique = () => `import-${Date.now()}-${randomBytes(3).toString('hex')}@example.test`;

let tenants: TwoTenants;
const createdEmails: string[] = [];

test.beforeAll(async () => {
  tenants = await seedTwoTenants();
  for (const t of [tenants.orgA, tenants.orgB]) await setOrgFeature(t.org.id, 'INTEGRATIONS_API', true);
});

test.afterAll(async () => {
  const orgIds = tenants?.orgIds ?? [];
  await prisma.job.deleteMany({ where: { name: 'api.import.candidates', orgId: { in: orgIds } } });
  await prisma.apiImport.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { email: { in: createdEmails }, orgId: { in: orgIds } } });
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds }, action: { startsWith: 'api.import' } } });
  await prisma.apiKey.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: orgIds } } });
  await tenants?.cleanup();
});

test('a queued import reports every row on its own and the report is the queuing key’s alone', { tag: '@smoke' }, async ({ request }) => {
  const key = await mintKey(tenants.orgA.org.id, 'candidates:write');
  const sibling = await mintKey(tenants.orgA.org.id, 'candidates:write');
  const other = await mintKey(tenants.orgB.org.id, 'candidates:write');
  const fresh = unique();
  createdEmails.push(fresh);

  const res = await request.post('/api/v1/imports/candidates', {
    headers: key.headers,
    data: {
      candidates: [
        { email: fresh, fullName: 'Ada Import', university: 'Example University', allowPossibleDuplicate: true },
        { email: tenants.orgA.mentee.email, fullName: 'Someone Else' },
        { email: 'not-an-email', fullName: 'Broken Row' },
        { email: fresh.toUpperCase(), fullName: 'Ada Again', allowPossibleDuplicate: true },
        { email: tenants.orgB.mentee.email, fullName: 'Other Tenant Person' },
        { email: unique(), fullName: 'Role Smuggler', role: 'ADMIN' },
      ],
    },
  });
  expect(res.status()).toBe(202);
  const queued = (await res.json()).data;
  expect(queued).toMatchObject({ kind: 'candidates', status: 'PENDING', total: 6, dryRun: false });
  expect(queued.rows).toBeUndefined();
  // On the queue, not inline.
  const job = await prisma.job.findFirst({ where: { name: 'api.import.candidates', orgId: tenants.orgA.org.id, idempotencyKey: `api.import:${queued.id}` } });
  expect(job?.payload).toEqual({ importId: queued.id });

  const done = await waitDone(request, queued.id, key.headers);
  expect(done.status).toBe('DONE');
  expect(done.counts).toMatchObject({ CREATE: 1, SKIP: 3, ERROR: 2 });
  const byRow = Object.fromEntries(done.rows!.map((r) => [r.row, r]));
  expect(byRow[1]).toMatchObject({ status: 'CREATE', key: fresh });
  expect(byRow[2]).toMatchObject({ status: 'SKIP', reason: 'duplicate_email', matches: [{ id: tenants.orgA.mentee.id }] });
  expect(byRow[3]).toMatchObject({ status: 'ERROR', key: 'not-an-email' });
  expect(byRow[3].reason).toContain('email');
  expect(byRow[4]).toMatchObject({ status: 'SKIP', reason: 'duplicate_in_batch' });
  // Another tenant's account blocks the address in this world but is not named.
  expect(byRow[5]).toMatchObject({ status: 'SKIP', reason: 'duplicate_email', matches: [] });
  expect(byRow[6]).toMatchObject({ status: 'ERROR' });

  const created = await prisma.user.findFirstOrThrow({ where: { email: fresh, orgId: tenants.orgA.org.id } });
  expect(created).toMatchObject({ id: byRow[1].id, role: 'MENTEE', fullName: 'Ada Import' });
  // Nothing else was created, and the submitted rows are not kept.
  expect(await prisma.user.count({ where: { fullName: { in: ['Broken Row', 'Ada Again', 'Role Smuggler', 'Other Tenant Person'] } } })).toBe(0);
  expect((await prisma.apiImport.findUniqueOrThrow({ where: { id: queued.id } })).input).toBeNull();

  for (const k of [sibling, other]) {
    const r = await request.get(`/api/v1/imports/${queued.id}`, { headers: k.headers });
    expect(r.status()).toBe(404);
    expect((await r.json()).type).toBe('not_found');
  }
});

test('a dry run plans and reports but writes nothing; scope and batch size are refused up front', { tag: '@smoke' }, async ({ request }) => {
  const key = await mintKey(tenants.orgB.org.id, 'candidates:write');
  const reader = await mintKey(tenants.orgB.org.id, 'candidates:read');
  const email = unique();

  const refused = await request.post('/api/v1/imports/candidates', { headers: reader.headers, data: { candidates: [{ email, fullName: 'X' }] } });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).type).toBe('insufficient_scope');
  const tooMany = await request.post('/api/v1/imports/candidates', {
    headers: key.headers,
    data: { candidates: Array.from({ length: 501 }, (_, i) => ({ email: `bulk-${i}@example.test`, fullName: 'B' })) },
  });
  expect(tooMany.status()).toBe(422);

  const res = await request.post('/api/v1/imports/candidates', { headers: key.headers, data: { dryRun: true, candidates: [{ email, fullName: 'Dry Run Person', allowPossibleDuplicate: true }] } });
  expect(res.status()).toBe(202);
  const done = await waitDone(request, (await res.json()).data.id, key.headers);
  expect(done).toMatchObject({ status: 'DONE', dryRun: true, counts: { CREATE: 1 } });
  expect(done.rows![0].id).toBeUndefined();
  expect(await prisma.user.count({ where: { email } })).toBe(0);
});

test('a key may have only a couple of imports in flight', async ({ request }) => {
  const key = await mintKey(tenants.orgB.org.id, 'candidates:write');
  // Rows with no job behind them stay PENDING: the cap is reached without racing the worker.
  await prisma.apiImport.createMany({
    data: [1, 2].map(() => ({ orgId: tenants.orgB.org.id, apiKeyId: key.id, kind: 'candidates', total: 0, input: '[]', expiresAt: new Date(Date.now() + 3600_000) })),
  });
  const res = await request.post('/api/v1/imports/candidates', { headers: key.headers, data: { candidates: [{ email: unique(), fullName: 'Capped' }] } });
  expect(res.status()).toBe(409);
  expect((await res.json()).type).toBe('limit_reached');
});
