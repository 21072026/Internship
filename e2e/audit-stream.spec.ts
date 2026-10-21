import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { E2E_AUDIT_SINK_PORT } from '../playwright.config';
import { operatorRequest } from './helpers/operator';

// The drain tick is platform-wide — it walks every tenant's drains — so the
// operator fires it, never a tenant admin (#1575). One context for the file.
let operator: APIRequestContext | null = null;
async function drainTick() {
  operator ??= await operatorRequest(test.info().project.use.baseURL);
  return operator.get('/api/cron?job=audit-drain');
}
test.afterAll(async () => {
  await operator?.dispose();
});


// The audit stream (#2012): a tenant's AuditLog rows, signed and POSTed to a
// receiver, read forward from a cursor that moves only on 2xx. Against the
// local sink in e2e/support/audit-sink.mjs this proves the contract in
// docs/audit-stream.md end to end — configure → deliver → outage → replay
// without loss or duplication → synthetic test batch — and the one security
// boundary: a receiver never gets another tenant's rows, and a tenant admin
// cannot see, edit, ping or delete another tenant's drain.

const SINK = `http://127.0.0.1:${E2E_AUDIT_SINK_PORT}`;
const PASS = 'DrainPass123';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function orgWithAdmin(tag: string, integrations = true) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}-${tag}`;
  const org = await prisma.organization.create({ data: { name: `Drain ${tag} ${stamp}`, slug: `drain-${stamp}` } });
  const email = uniqueEmail(`drain-${tag}`);
  const admin = await seedUser(email, PASS, 'ADMIN', `${tag} Drain Admin`);
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  // Streaming the audit trail out is the INTEGRATIONS_API feature (#1744).
  if (integrations) await setOrgFeature(org.id, 'INTEGRATIONS_API', true);
  return { org, email, admin };
}

async function cleanupOrg(o: { org: { id: string }; email: string }) {
  await prisma.auditDrain.deleteMany({ where: { orgId: o.org.id } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { orgId: o.org.id } }).catch(() => {});
  await cleanupByEmail(o.email);
  await prisma.organization.delete({ where: { id: o.org.id } }).catch(() => {});
}

/** A few audit rows for an org, in a known order (ascending createdAt). */
async function auditRows(orgId: string, actorId: string, n: number, tag: string) {
  const base = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const row = await prisma.auditLog.create({
      data: { orgId, actorId, action: `E2E_${tag}_${i}`, targetId: null, detail: i % 2 ? JSON.stringify({ i }) : null, createdAt: new Date(base + i * 10) },
      select: { id: true },
    });
    ids.push(row.id);
  }
  return ids;
}

interface SinkBatch {
  path: string;
  headers: { signature: string | null; batchId: string | null; count: string | null; format: string | null; test: string | null; contentType: string | null };
  body: string;
}
async function sinkBatches(request: APIRequestContext): Promise<SinkBatch[]> {
  return (await (await request.get(`${SINK}/__received`)).json()).batches;
}
async function sinkReset(request: APIRequestContext) {
  await request.post(`${SINK}/__reset`);
}
async function sinkOutage(request: APIRequestContext, on: boolean) {
  await request.post(`${SINK}/__outage`, { data: { on } });
}
function lines(batch: SinkBatch): Array<Record<string, unknown>> {
  return batch.body.trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function sign(secret: string, body: string) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

test('configure → deliver → outage → replay without loss or duplication → test batch', async ({ page }) => {
  const a = await orgWithAdmin('A');
  try {
    await sinkReset(page.request);
    await signInAndSettle(page, a.email, PASS, '/admin');

    // 1. Register the receiver; the secret comes back exactly once.
    const created = await page.request.post('/api/admin/audit-drains', { data: { url: `${SINK}/ingest-a`, format: 'json_lines' } });
    expect(created.status()).toBe(201);
    const { drain, secret } = await created.json();
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThan(20);
    const listed = await (await page.request.get('/api/admin/audit-drains')).json();
    expect(listed.drains.map((d: { id: string }) => d.id)).toContain(drain.id);
    expect(JSON.stringify(listed)).not.toContain(secret);

    // 2. Three audit rows for the tenant, one tick, one signed batch.
    const first = await auditRows(a.org.id, a.admin.id, 3, 'FIRST');
    const tick1 = await drainTick();
    expect(tick1.ok()).toBeTruthy();
    const batches1 = await sinkBatches(page.request);
    const mine1 = batches1.filter((b) => b.path === '/ingest-a');
    expect(mine1.length).toBe(1);
    const [b1] = mine1;
    expect(b1.headers.contentType).toBe('application/x-ndjson');
    expect(b1.headers.format).toBe('json_lines');
    expect(b1.headers.count).toBe('3');
    expect(b1.headers.test).toBeNull();
    expect(b1.headers.signature).toBe(sign(secret, b1.body));
    const ids1 = lines(b1).map((l) => l.id);
    expect(ids1).toEqual(first);
    expect(lines(b1)[1].detail).toEqual({ i: 1 });
    expect(lines(b1).every((l) => l.orgId === a.org.id)).toBeTruthy();
    const afterFirst = await prisma.auditDrain.findUnique({ where: { id: drain.id } });
    expect(afterFirst?.cursorId).toBe(first[2]);
    expect(afterFirst?.failures).toBe(0);
    expect(afterFirst?.lastOkAt).not.toBeNull();

    // 3. The receiver goes down. New rows are NOT lost: the cursor stays, the
    //    failure is counted and the next attempt is pushed out.
    await sinkReset(page.request);
    await sinkOutage(page.request, true);
    const second = await auditRows(a.org.id, a.admin.id, 2, 'SECOND');
    const tick2 = await (await drainTick()).json();
    expect(tick2.auditDrain.failed).toBeGreaterThanOrEqual(1);
    const down = await prisma.auditDrain.findUnique({ where: { id: drain.id } });
    expect(down?.cursorId).toBe(first[2]);
    expect(down?.failures).toBe(1);
    expect(down?.active).toBe(true);
    expect(down?.lastError).toContain('HTTP 503');
    expect(down!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await sinkBatches(page.request)).toHaveLength(0);

    // 4. Still in backoff: a tick does nothing even once the sink is back.
    await sinkOutage(page.request, false);
    await drainTick();
    expect(await sinkBatches(page.request)).toHaveLength(0);

    // 5. The backoff elapses (the clock is moved in the row, as a minute later
    //    would): exactly the two unsent rows arrive — a replay, not a repeat.
    await prisma.auditDrain.update({ where: { id: drain.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await drainTick();
    const mine2 = (await sinkBatches(page.request)).filter((b) => b.path === '/ingest-a');
    expect(mine2.length).toBe(1);
    expect(lines(mine2[0]).map((l) => l.id)).toEqual(second);
    expect(mine2[0].headers.signature).toBe(sign(secret, mine2[0].body));
    const recovered = await prisma.auditDrain.findUnique({ where: { id: drain.id } });
    expect(recovered?.cursorId).toBe(second[1]);
    expect(recovered?.failures).toBe(0);
    expect(recovered?.nextAttemptAt).toBeNull();
    expect(recovered?.lastError).toBeNull();

    // 6. The test batch: two synthetic rows, flagged, signed; the cursor does
    //    not move and no real row is in it.
    await sinkReset(page.request);
    const probe = await (await page.request.post(`/api/admin/audit-drains/test?id=${drain.id}`)).json();
    expect(probe.ok).toBe(true);
    const [tb] = (await sinkBatches(page.request)).filter((b) => b.path === '/ingest-a');
    expect(tb.headers.test).toBe('1');
    expect(tb.headers.signature).toBe(sign(secret, tb.body));
    const testLines = lines(tb);
    expect(testLines).toHaveLength(2);
    expect(testLines.every((l) => String(l.id).startsWith('test-') && l.action === 'audit.drain.test')).toBeTruthy();
    expect((await prisma.auditDrain.findUnique({ where: { id: drain.id } }))?.cursorId).toBe(second[1]);

    // 7. The console shows the drain and the health board has a row for it.
    await page.goto('/admin/integrations');
    await expect(page.locator(`[data-testid="audit-drain-${drain.id}"]:visible`)).toContainText('/ingest-a');
    await expect(page.locator('[data-testid="health-row-audit_drain"]:visible')).toBeVisible();

    // 8. Pause, then delete.
    const paused = await (await page.request.patch(`/api/admin/audit-drains?id=${drain.id}`, { data: { active: false } })).json();
    expect(paused.drain.active).toBe(false);
    await page.request.delete(`/api/admin/audit-drains?id=${drain.id}`);
    expect(await prisma.auditDrain.findUnique({ where: { id: drain.id } })).toBeNull();
  } finally {
    await sinkReset(page.request).catch(() => {});
    await cleanupOrg(a);
  }
});

test('a receiver gets only its own tenant’s rows, and a tenant admin reaches only its own drains', { tag: '@smoke' }, async ({ page }) => {
  const a = await orgWithAdmin('A');
  const b = await orgWithAdmin('B');
  try {
    await sinkReset(page.request);
    // Both drains written straight to the DB with their orgId, both active,
    // pointing at two paths of the same sink.
    const drainA = await prisma.auditDrain.create({ data: { orgId: a.org.id, url: `${SINK}/tenant-a`, secret: 'sa', format: 'json_lines' } });
    const drainB = await prisma.auditDrain.create({ data: { orgId: b.org.id, url: `${SINK}/tenant-b`, secret: 'sb', format: 'ecs' } });
    const rowsA = await auditRows(a.org.id, a.admin.id, 2, 'TA');
    const rowsB = await auditRows(b.org.id, b.admin.id, 2, 'TB');

    await signInAndSettle(page, a.email, PASS, '/admin');
    const tick = await drainTick();
    expect(tick.ok()).toBeTruthy();
    const batches = await sinkBatches(page.request);
    const toA = batches.filter((x) => x.path === '/tenant-a').flatMap(lines).map((l) => l.id);
    const toB = batches.filter((x) => x.path === '/tenant-b').flatMap((x) => lines(x).map((l) => (l.event as { id: string }).id));
    expect(toA.sort()).toEqual([...rowsA].sort());
    expect(toB.sort()).toEqual([...rowsB].sort());
    for (const id of rowsB) expect(toA).not.toContain(id);
    for (const id of rowsA) expect(toB).not.toContain(id);
    // ECS shape on B's batch: the tenant under organization.id, the original record kept.
    const ecs = batches.filter((x) => x.path === '/tenant-b').flatMap(lines)[0];
    expect((ecs.organization as { id: string }).id).toBe(b.org.id);
    expect((ecs.interncrm as { audit: { orgId: string } }).audit.orgId).toBe(b.org.id);

    // Admin A's view and writes stop at the tenant boundary.
    const list = await (await page.request.get('/api/admin/audit-drains')).json();
    const ids = (list.drains as { id: string }[]).map((d) => d.id);
    expect(ids).toContain(drainA.id);
    expect(ids).not.toContain(drainB.id);
    expect((await page.request.patch(`/api/admin/audit-drains?id=${drainB.id}`, { data: { active: false } })).status()).toBe(404);
    expect((await prisma.auditDrain.findUnique({ where: { id: drainB.id } }))?.active).toBe(true);
    expect((await page.request.post(`/api/admin/audit-drains/rotate-secret?id=${drainB.id}`)).status()).toBe(404);
    expect((await prisma.auditDrain.findUnique({ where: { id: drainB.id } }))?.secret).toBe('sb');
    expect((await page.request.post(`/api/admin/audit-drains/test?id=${drainB.id}`)).status()).toBe(404);
    await page.request.delete(`/api/admin/audit-drains?id=${drainB.id}`);
    expect(await prisma.auditDrain.findUnique({ where: { id: drainB.id } })).not.toBeNull();
  } finally {
    await sinkReset(page.request).catch(() => {});
    await cleanupOrg(a);
    await cleanupOrg(b);
  }
});

test('the receiver URL rule, the plan gate and the admin guard', async ({ page, request }) => {
  // Anonymous and non-admin callers get nothing.
  expect((await request.get('/api/admin/audit-drains')).status()).toBe(401);
  const mentorEmail = uniqueEmail('drain-mentor');
  await seedUser(mentorEmail, PASS, 'MENTOR', 'Drain Mentor');
  const locked = await orgWithAdmin('L', false);
  try {
    await signInAndSettle(page, mentorEmail, PASS, '/mentor');
    expect([401, 403]).toContain((await page.request.get('/api/admin/audit-drains')).status());

    // A plan without INTEGRATIONS_API cannot add a receiver.
    await page.context().clearCookies();
    await signInAndSettle(page, locked.email, PASS, '/admin');
    const refused = await page.request.post('/api/admin/audit-drains', { data: { url: `${SINK}/x` } });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('feature_locked');

    // With it, the URL rule still applies: credentials in the authority and
    // garbage are 400 with the reason; nothing is created.
    await setOrgFeature(locked.org.id, 'INTEGRATIONS_API', true);
    const creds = await page.request.post('/api/admin/audit-drains', { data: { url: 'https://user:pw@siem.example/ingest' } });
    expect(creds.status()).toBe(400);
    expect((await creds.json()).code).toBe('credentials');
    const junk = await page.request.post('/api/admin/audit-drains', { data: { url: 'not a url' } });
    expect(junk.status()).toBe(400);
    expect((await junk.json()).code).toBe('invalid');
    expect(await prisma.auditDrain.count({ where: { orgId: locked.org.id } })).toBe(0);
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupOrg(locked);
  }
});
