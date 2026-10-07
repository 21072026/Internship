import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, setOrgFeature, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Per-key budgets and the period quota at the /api/v1 door (#2010). Keys are
// seeded straight into the database (sha256 of the raw secret, as in
// api-v1-key-enforcement.spec.ts). Every key here is fresh, so its per-minute
// window and its period tally start at zero whatever else the suite did.

const KEY_PREFIX = 'e2e-v1-quota';
const CANDIDATES = '/api/v1/candidates';
const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });
let orgId = '';
const adminEmail = uniqueEmail('quota-admin');

async function seedKey(opts: { quotaPeriod?: 'day' | 'month'; quotaLimit?: number } = {}) {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  const key = await prisma.apiKey.create({
    data: {
      name: `${KEY_PREFIX}-${randomBytes(4).toString('hex')}`,
      hashedKey: createHash('sha256').update(raw).digest('hex'),
      scopes: 'candidates:read',
      orgId,
      quotaPeriod: opts.quotaPeriod ?? null,
      quotaLimit: opts.quotaLimit ?? null,
    },
  });
  return { id: key.id, raw };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `V1 Quota ${Date.now()}`, slug: `v1-quota-${Date.now()}-${randomBytes(2).toString('hex')}` } });
  orgId = org.id;
  await setOrgFeature(orgId, 'INTEGRATIONS_API', true);
  const admin = await seedUser(adminEmail, 'QuotaAdmin123!', 'ADMIN', 'Quota Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId } });
});

test.afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } });
  await cleanupByEmail(adminEmail);
  await prisma.orgEntitlement.deleteMany({ where: { orgId } });
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
});

test('two keys from the same address have independent per-minute budgets, and every response says where it stands', { tag: '@smoke' }, async ({ request }) => {
  const a = await seedKey();
  const b = await seedKey();

  const first = await request.get(CANDIDATES, { headers: bearer(a.raw) });
  expect(first.status()).toBe(200);
  expect(first.headers()['ratelimit-limit']).toBe('120');
  expect(first.headers()['ratelimit-remaining']).toBe('119');
  expect(Number(first.headers()['ratelimit-reset'])).toBeGreaterThan(0);

  // Spend the rest of A's window: 119 more answered, the next one refused.
  for (let sent = 1; sent < 120; sent += 17) {
    const batch = Array.from({ length: Math.min(17, 120 - sent) }, () => request.get(CANDIDATES, { headers: bearer(a.raw) }));
    for (const r of await Promise.all(batch)) expect(r.status()).toBe(200);
  }
  const refused = await request.get(CANDIDATES, { headers: bearer(a.raw) });
  expect(refused.status()).toBe(429);
  expect(await refused.json()).toMatchObject({ type: 'rate_limited' });
  expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(0);
  expect(refused.headers()['ratelimit-remaining']).toBe('0');

  // B, same address, untouched by A.
  const other = await request.get(CANDIDATES, { headers: bearer(b.raw) });
  expect(other.status()).toBe(200);
  expect(other.headers()['ratelimit-remaining']).toBe('119');

  // No key at all: refused as before, and still told its address's budget.
  const anonymous = await request.get(CANDIDATES);
  expect(anonymous.status()).toBe(401);
  expect(anonymous.headers()['ratelimit-limit']).toBe('120');
});

test('a key past its period allowance gets 429 quota_exceeded with the reset instant; usage is counted without a write per request', async ({ playwright, request }, info) => {
  const c = await seedKey({ quotaPeriod: 'day', quotaLimit: 2 });
  const r1 = await request.get(CANDIDATES, { headers: bearer(c.raw) });
  expect(r1.status()).toBe(200);
  // The allowance binds harder than the minute window, so it is what the headers report.
  expect(r1.headers()['ratelimit-limit']).toBe('2');
  expect(r1.headers()['ratelimit-remaining']).toBe('1');
  const r2 = await request.get(CANDIDATES, { headers: bearer(c.raw) });
  expect(r2.status()).toBe(200);
  expect(r2.headers()['ratelimit-remaining']).toBe('0');

  const r3 = await request.get(CANDIDATES, { headers: bearer(c.raw) });
  expect(r3.status()).toBe(429);
  const body = await r3.json();
  const tomorrow = new Date();
  tomorrow.setUTCHours(24, 0, 0, 0);
  expect(body).toMatchObject({ type: 'quota_exceeded', resetAt: tomorrow.toISOString() });
  expect(Number(r3.headers()['retry-after'])).toBeGreaterThan(0);

  // The tally lands in ApiKeyUsage in one batched write — the refused call is not counted.
  await expect.poll(async () => (await prisma.apiKeyUsage.findFirst({ where: { apiKeyId: c.id } }))?.requests ?? 0, { timeout: 15_000 }).toBe(2);

  // An unmetered key is never refused by period and is still tallied (by month).
  const d = await seedKey();
  expect((await request.get(CANDIDATES, { headers: bearer(d.raw) })).status()).toBe(200);

  // The admin key list shows usage against the allowance.
  const admin = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  try {
    expect((await signInViaApi(admin, adminEmail, 'QuotaAdmin123!')).ok).toBe(true);
    const list = await admin.get('/api/admin/api-keys');
    // A session-authenticated request is never metered by the key quota.
    expect(list.headers()['ratelimit-limit']).toBeUndefined();
    const keys = (await list.json()).keys as { id: string; quotaPeriod: string | null; quotaLimit: number | null; usage: { period: string; requests: number } }[];
    expect(keys.find((k) => k.id === c.id)).toMatchObject({ quotaPeriod: 'day', quotaLimit: 2, usage: { period: 'day', requests: 2 } });
    expect(keys.find((k) => k.id === d.id)).toMatchObject({ quotaPeriod: null, usage: { period: 'month', requests: 1 } });

    // The admin raises the allowance in place; the key is served again.
    const patch = await admin.patch(`/api/admin/api-keys?id=${c.id}`, { data: { quotaPeriod: 'day', quotaLimit: 5 } });
    expect(patch.status()).toBe(200);
    expect((await request.get(CANDIDATES, { headers: bearer(c.raw) })).status()).toBe(200);
    expect((await admin.patch(`/api/admin/api-keys?id=${c.id}`, { data: { quotaPeriod: 'week', quotaLimit: 5 } })).status()).toBe(400);
  } finally {
    await admin.dispose();
  }
});
