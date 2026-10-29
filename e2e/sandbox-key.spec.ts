import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';
import { mintSandboxKey } from '@/lib/api/sandboxKey';
import { defaultOrgId } from '@/lib/defaultOrg';
import { SANDBOX_KEY_NAME } from '@/lib/api/sandboxKeyRule';

// What a sandbox key (#1992) can do once minted. The route only mints on the
// demo deployment (e2e/sandbox-key.unit.spec.ts, and the 404 in
// e2e/developers-portal.spec.ts); here the minting function is called directly
// so the KEY is tested against the real /api/v1: it reads the default org and
// nothing it may write goes through.

let keyId = '';
let grantCreated = false;

test.afterAll(async () => {
  if (keyId) await prisma.apiKey.deleteMany({ where: { name: SANDBOX_KEY_NAME } });
  if (grantCreated) await prisma.orgEntitlement.deleteMany({ where: { orgId: await defaultOrgId(), feature: 'INTEGRATIONS_API' } });
  await prisma.$disconnect();
});

test('a sandbox key reads the default organisation and cannot write', { tag: '@smoke' }, async ({ request }) => {
  const orgId = await defaultOrgId();
  // The demo seed grants this (prisma/seed-demo.mjs); the test database is not seeded with it.
  const existing = await prisma.orgEntitlement.findUnique({ where: { orgId_feature: { orgId, feature: 'INTEGRATIONS_API' } } });
  if (!existing) {
    await prisma.orgEntitlement.create({ data: { orgId, feature: 'INTEGRATIONS_API', note: 'e2e sandbox-key' } });
    grantCreated = true;
  }

  const minted = await mintSandboxKey();
  expect(minted.ok).toBe(true);
  if (!minted.ok) return;
  const row = await prisma.apiKey.findFirstOrThrow({ where: { name: SANDBOX_KEY_NAME }, orderBy: { createdAt: 'desc' } });
  keyId = row.id;
  expect(row.orgId).toBe(orgId);
  expect(row.quotaPeriod).toBe('day');
  expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);

  const auth = { Authorization: `Bearer ${minted.key}` };
  expect((await request.get('/api/v1/candidates', { headers: auth })).status()).toBe(200);
  const write = await request.post('/api/v1/candidates', {
    headers: { ...auth, 'Idempotency-Key': `sandbox-${Date.now()}` },
    data: { fullName: 'Sandbox Write', email: `sandbox-${Date.now()}@example.test` },
  });
  expect(write.status()).toBe(403);
  expect((await write.json()).type).toBe('insufficient_scope');
});
