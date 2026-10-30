import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('impersonation records a reason and notifies the impersonated user', async ({ page }) => {
  const adminEmail = uniqueEmail('ig-admin');
  const targetEmail = uniqueEmail('ig-target');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'IG Admin');
  const target = await seedUser(targetEmail, 'x', 'MENTEE', 'IG Target');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/admin/impersonate', {
      data: { targetUserId: target.id, reason: 'support investigation' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).grant).toBeTruthy();

    // The impersonated user got a transparency notification.
    const notif = await prisma.notification.findFirst({ where: { userId: target.id, type: 'impersonation.accessedWithReason' } });
    expect(notif).toBeTruthy();
    expect((notif?.params as { reason?: string })?.reason).toBe('support investigation');
  } finally {
    await prisma.notification.deleteMany({ where: { userId: target.id } });
    await cleanupByEmail(targetEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('impersonating another admin is rejected by the API', async ({ page }) => {
  const adminEmail = uniqueEmail('ig-admin2');
  const otherAdminEmail = uniqueEmail('ig-other-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'IG Admin Two');
  const otherAdmin = await seedUser(otherAdminEmail, 'x', 'ADMIN', 'IG Other Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/admin/impersonate', {
      data: { targetUserId: otherAdmin.id },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('admin');
    const started = await prisma.auditLog.findFirst({
      where: { action: 'IMPERSONATE_START', targetId: otherAdmin.id },
    });
    expect(started).toBeNull();
  } finally {
    await cleanupByEmail(otherAdminEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('a failed impersonation attempt shows an inline error and re-enables the button', async ({ page }) => {
  const adminEmail = uniqueEmail('ig-admin3');
  const otherAdminEmail = uniqueEmail('ig-other-admin2');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'IG Admin Three');
  const otherAdmin = await seedUser(otherAdminEmail, 'x', 'ADMIN', 'IG Other Admin Two');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/users');
    page.once('dialog', (d) => d.dismiss());
    const row = page.getByTestId(`user-row-${otherAdmin.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: 'Login as' }).click();

    await expect(row.getByText(/cannot impersonate an admin/i)).toBeVisible({ timeout: 10_000 });
    // The button resets to clickable rather than staying stuck disabled.
    await expect(row.getByRole('button', { name: 'Login as' })).toBeEnabled();
    // No session/route change happened.
    expect(page.url()).toContain('/admin/users');
  } finally {
    await cleanupByEmail(otherAdminEmail);
    await cleanupByEmail(adminEmail);
  }
});

// ── Per-organization impersonation policy (#1586) ───────────────────────────
// full | read_only | off on the TARGET's organization. `off` mints nothing;
// `read_only` is ONE central write refusal in middleware, proved here on
// PUT /api/profile, a route that carries no hand-written impersonation block.

async function policyFixture(policy: 'full' | 'read_only' | 'off') {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Imp ${stamp}`, slug: `imp-${stamp}`, impersonationPolicy: policy } });
  const adminEmail = uniqueEmail('imp-pol-admin').toLowerCase();
  const targetEmail = uniqueEmail('imp-pol-target').toLowerCase();
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Imp Admin', org.id);
  const target = await seedUser(targetEmail, 'TargetPass123!', 'MENTEE', 'Imp Target', org.id);
  const admin = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const signed = await signInViaApi(admin, adminEmail, 'AdminPass123!');
  expect(signed.ok, `admin sign-in failed: ${signed.error}`).toBe(true);
  const cleanup = async () => {
    await admin.dispose();
    await prisma.impersonationGrant.deleteMany({ where: { targetId: target.id } });
    await prisma.notification.deleteMany({ where: { userId: target.id } });
    await prisma.auditLog.deleteMany({ where: { targetId: target.id } });
    await cleanupByEmail(targetEmail);
    await cleanupByEmail(adminEmail);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  };
  return { org, target, admin, cleanup };
}

test('impersonation policy off: the start is refused with 403, no grant is minted and nobody is told', { tag: '@smoke' }, async () => {
  const f = await policyFixture('off');
  try {
    const res = await f.admin.post('/api/admin/impersonate', { data: { targetUserId: f.target.id, reason: 'support' } });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('impersonation_off');
    expect(await prisma.impersonationGrant.count({ where: { targetId: f.target.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: f.target.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'IMPERSONATE_START', targetId: f.target.id } })).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test('impersonation policy read_only: every write is refused centrally, reads and the way out still work', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const f = await policyFixture('read_only');
  const imp = await playwright.request.newContext({ baseURL });
  try {
    const start = await f.admin.post('/api/admin/impersonate', { data: { targetUserId: f.target.id } });
    expect(start.ok()).toBe(true);
    const { grant, readOnly } = await start.json();
    expect(readOnly).toBe(true);

    const csrf = await (await imp.get('/api/auth/csrf')).json();
    await imp.post('/api/auth/callback/impersonate', { form: { csrfToken: csrf.csrfToken, grant, json: 'true' }, maxRedirects: 0 });
    const session = await (await imp.get('/api/auth/session')).json();
    expect(session?.user?.impersonatorId).toBeTruthy();
    expect(session?.user?.impersonationReadOnly).toBe(true);

    // A write on a route with no hand-written block: refused by middleware.
    const before = await prisma.user.findUniqueOrThrow({ where: { id: f.target.id }, select: { city: true } });
    const write = await imp.put('/api/profile', { data: { city: 'Changed By Admin' } });
    expect(write.status()).toBe(403);
    expect((await write.json()).code).toBe('impersonation_read_only');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.target.id }, select: { city: true } })).city).toBe(before.city);

    // Reads still work, and so does the way out.
    expect((await imp.get('/api/profile')).status()).toBe(200);
    const stop = await imp.post('/api/impersonate/stop');
    expect(stop.status()).toBe(200);
    expect((await stop.json()).grant).toBeTruthy();
  } finally {
    await imp.dispose();
    await f.cleanup();
  }
});

test('impersonation policy: the org admin sets it for their own org only; full stays the default', { tag: '@smoke' }, async () => {
  const f = await policyFixture('full');
  const other = await prisma.organization.create({ data: { name: `Imp other ${Date.now()}`, slug: `imp-o-${Date.now()}-${crypto.randomBytes(2).toString('hex')}` } });
  try {
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: other.id } })).impersonationPolicy).toBe('full');
    const api = `/api/admin/organizations/${f.org.id}/impersonation-policy`;
    expect((await (await f.admin.get(api)).json()).policy).toBe('full');
    expect((await f.admin.patch(api, { data: { policy: 'everything' } })).status()).toBe(400);
    expect((await f.admin.patch(api, { data: { policy: 'read_only' } })).status()).toBe(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: f.org.id } })).impersonationPolicy).toBe('read_only');
    // Another tenant's policy is not this admin's to read or set.
    expect((await f.admin.patch(`/api/admin/organizations/${other.id}/impersonation-policy`, { data: { policy: 'off' } })).status()).toBe(403);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: other.id } })).impersonationPolicy).toBe('full');
  } finally {
    await prisma.organization.deleteMany({ where: { id: other.id } });
    await f.cleanup();
  }
});
