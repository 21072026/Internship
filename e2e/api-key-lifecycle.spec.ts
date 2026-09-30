import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

// API key lifecycle (#1545): an API key is no longer "a name and a hash".
// It records who minted it, when it stops being valid, what it may read, and
// whether it was withdrawn — and revoking it must NOT delete the row, because
// the apikey.revoked activity entry points at that id.
//
// ENFORCEMENT (refusing an expired/revoked/out-of-scope key at the /api/v1
// door) is #1546 and is deliberately not asserted here.

const KEY_PREFIX = 'e2e-lifecycle-key';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signInAsAdmin(page: import('@playwright/test').Page, email: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', 'AdminPass123');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
}

test('an API key needs at least one scope, and records owner + expiry', async ({ page }) => {
  const adminEmail = uniqueEmail('key-admin');
  const keyName = `${KEY_PREFIX}-${Date.now()}`;
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Key Lifecycle Admin');
  try {
    await signInAsAdmin(page, adminEmail);

    // A key that can read nothing is a credential with no purpose.
    const noScopes = await page.request.post('/api/admin/api-keys', {
      data: { name: keyName, scopes: [] },
    });
    expect(noScopes.status()).toBe(400);

    // An unknown scope string is not a scope either.
    const badScope = await page.request.post('/api/admin/api-keys', {
      data: { name: keyName, scopes: ['everything:read'] },
    });
    expect(badScope.status()).toBe(400);

    // An expiry beyond the 12-month ceiling is refused.
    const tooFar = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
    const farExpiry = await page.request.post('/api/admin/api-keys', {
      data: { name: keyName, scopes: ['candidates:read'], expiresAt: tooFar },
    });
    expect(farExpiry.status()).toBe(400);

    // The happy path: one scope, an expiry inside the ceiling.
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const created = await page.request.post('/api/admin/api-keys', {
      data: { name: keyName, scopes: ['candidates:read'], expiresAt },
    });
    expect(created.status()).toBe(201);
    const body = await created.json();
    // The raw key is still shown exactly once, at creation.
    expect(body.key).toMatch(/^icrm_/);
    expect(body.scopes).toEqual(['candidates:read']);

    // The list reports owner, scopes, expiry and a derived status — and never
    // the hash or the raw key.
    const listed = await page.request.get('/api/admin/api-keys');
    expect(listed.ok()).toBeTruthy();
    const listBody = await listed.json();
    expect(JSON.stringify(listBody)).not.toContain(body.key);
    expect(JSON.stringify(listBody)).not.toContain('hashedKey');
    const row = listBody.keys.find((k: { id: string }) => k.id === body.id);
    expect(row).toBeTruthy();
    expect(row.scopes).toEqual(['candidates:read']);
    expect(row.status).toBe('active');
    expect(row.revokedAt).toBeFalsy();
    expect(row.expiresAt).toBeTruthy();
    expect(row.createdBy.email).toBe(adminEmail);

    // The admin screen surfaces owner and expiry next to the key.
    await page.goto('/admin/integrations');
    const owner = page.getByTestId(`api-key-owner-${body.id}`);
    await expect(owner).toBeVisible();
    await expect(owner).toContainText('Key Lifecycle Admin');
    await expect(page.getByTestId(`api-key-expiry-${body.id}`)).toBeVisible();
    await expect(page.getByTestId(`api-key-status-${body.id}`)).toBeVisible();
  } finally {
    await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } });
    await cleanupByEmail(adminEmail);
  }
});

test('revoking a key is soft: the row survives with revokedAt set', async ({ page }) => {
  const adminEmail = uniqueEmail('key-revoke-admin');
  const keyName = `${KEY_PREFIX}-revoke-${Date.now()}`;
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Key Revoke Admin');
  try {
    await signInAsAdmin(page, adminEmail);

    const created = await page.request.post('/api/admin/api-keys', {
      data: { name: keyName, scopes: ['candidates:read'] },
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json();

    // A key minted without an expiry is flagged in the list.
    await page.goto('/admin/integrations');
    await expect(page.getByTestId(`api-key-no-expiry-${id}`)).toBeVisible();

    const revoked = await page.request.delete(`/api/admin/api-keys?id=${id}`);
    expect(revoked.ok()).toBeTruthy();

    // The row is STILL THERE — a hard delete would orphan the audit entry.
    const stored = await prisma.apiKey.findUnique({ where: { id } });
    expect(stored).not.toBeNull();
    expect(stored?.revokedAt).not.toBeNull();

    const listBody = await (await page.request.get('/api/admin/api-keys')).json();
    const row = listBody.keys.find((k: { id: string }) => k.id === id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('revoked');
  } finally {
    await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } });
    await cleanupByEmail(adminEmail);
  }
});

// #2645: the list and the revoke are tenant-scoped on their own, not only
// through the middleware (which is off while MT_ENFORCE_ISOLATION is). Before,
// another tenant's admin read this key — with its creator's e-mail — and could
// revoke it by id.
test("one tenant's admin can neither see nor revoke another tenant's key (#2645)", async ({ page }) => {
  const stamp = Date.now();
  const ownerEmail = uniqueEmail('key-owner');
  const otherEmail = uniqueEmail('key-other-tenant');
  const org = await prisma.organization.create({ data: { name: `Key Org ${stamp}`, slug: `key-org-${stamp}` } });
  const owner = await seedUser(ownerEmail, 'AdminPass123', 'ADMIN', 'Key Owner');
  await seedUser(otherEmail, 'AdminPass123', 'ADMIN', 'Other Tenant Admin', org.id);
  const key = await prisma.apiKey.create({
    data: {
      name: `${KEY_PREFIX}-tenant-${stamp}`,
      hashedKey: `e2e-tenant-${stamp}`,
      scopes: 'candidates:read',
      createdById: owner.id,
    },
  });
  try {
    await signInAsAdmin(page, otherEmail);

    const list = await page.request.get('/api/admin/api-keys');
    expect(list.ok()).toBeTruthy();
    const body = await list.text();
    expect(body).not.toContain(key.id);
    expect(body).not.toContain(ownerEmail);

    const revoke = await page.request.delete(`/api/admin/api-keys?id=${key.id}`);
    expect(revoke.ok()).toBeTruthy();
    expect((await prisma.apiKey.findUnique({ where: { id: key.id } }))?.revokedAt).toBeNull();
    expect(await prisma.activityLog.count({ where: { action: 'apikey.revoked', targetId: key.id } })).toBe(0);

    // The owner's tenant still sees and manages it (a NULL-org key is the default org's).
    // signInAsFreshUser leaves the page first, so no in-flight /admin request
    // can write the other admin's session cookie back after it is dropped.
    await signInAsFreshUser(page, ownerEmail, 'AdminPass123', '/admin');
    const own = await (await page.request.get('/api/admin/api-keys')).json();
    expect((own.keys as { id: string }[]).some((k) => k.id === key.id)).toBe(true);
  } finally {
    await prisma.activityLog.deleteMany({ where: { targetId: key.id } });
    await prisma.apiKey.deleteMany({ where: { id: key.id } });
    await cleanupByEmail(ownerEmail);
    await cleanupByEmail(otherEmail);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
