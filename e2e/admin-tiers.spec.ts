import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail, seedUser } from './helpers/db';
import { signInViaApi } from './helpers/auth';

/**
 * Admin tier & scope assignment (#1579). Every guard is proved by calling the
 * API, never by a disabled control:
 *   • a tier change signs the target out — sessionsValidFrom AND their
 *     trusted devices (CLAUDE.md) — and writes an AuditLog row + a notice;
 *   • nobody changes their own tier; a narrower tier cannot assign at all
 *     (`admin.grant` is ORG_ADMIN's), so nobody mints a tier above their own;
 *   • scope grants name a cohort/company of the SAME org;
 *   • the last active ORG_ADMIN stays — here through account self-deletion,
 *     the path where the old "any ADMIN counts" guard let an org end up with
 *     observers only.
 * The pure guards (incl. the demotion branch a running app reaches only on a
 * race) are unit-tested in scripts/test/admin-tier-rule.test.mjs.
 */

const PASSWORD = 'AdminTier123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function ctxFor(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const res = await signInViaApi(ctx, email, PASSWORD);
  expect(res.ok, `sign-in failed for ${email}: ${res.error}`).toBe(true);
  return ctx;
}

test('admin tiers: a demotion signs the target out everywhere, is audited and notified; self-change and a narrower tier are refused', { tag: '@smoke' }, async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Tiers ${stamp}`, slug: `tiers-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `Tiers other ${stamp}`, slug: `tiers-o-${stamp}` } });
  const aEmail = uniqueEmail('tier-a').toLowerCase();
  const bEmail = uniqueEmail('tier-b').toLowerCase();
  const cEmail = uniqueEmail('tier-c').toLowerCase();
  const a = await seedUser(aEmail, PASSWORD, 'ADMIN', 'Tier A', org.id);
  const b = await seedUser(bEmail, PASSWORD, 'ADMIN', 'Tier B', org.id);
  const c = await seedUser(cEmail, PASSWORD, 'ADMIN', 'Tier C', org.id);
  await prisma.user.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { adminLevel: 'ORG_ADMIN' } });
  await prisma.user.update({ where: { id: c.id }, data: { adminLevel: 'OBSERVER' } });
  const cohort = await prisma.cohort.create({ data: { name: `Tier cohort ${stamp}`, orgId: org.id } });
  const foreignCohort = await prisma.cohort.create({ data: { name: `Foreign cohort ${stamp}`, orgId: other.id } });
  const ctxA = await ctxFor(aEmail);
  const ctxB = await ctxFor(bEmail);
  try {
    // B holds a live session and a remembered browser.
    expect((await ctxB.get('/api/admin/roles')).status()).toBe(200);
    await prisma.trustedDevice.create({
      data: {
        userId: b.id,
        tokenHash: crypto.randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 86_400_000),
        absoluteExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    const listed = await (await ctxA.get('/api/admin/roles')).json();
    expect(listed.admins.map((x: { id: string; tier: string }) => [x.id, x.tier]).sort()).toEqual(
      [[a.id, 'ORG_ADMIN'], [b.id, 'ORG_ADMIN'], [c.id, 'OBSERVER']].sort(),
    );

    // No self-change, either way.
    const self = await ctxA.patch('/api/admin/roles', { data: { userId: a.id, tier: 'OBSERVER' } });
    expect(self.status()).toBe(400);
    expect((await self.json()).code).toBe('self_change');

    // A demotes B: signed out everywhere, audited, told.
    const before = Date.now();
    const demote = await ctxA.patch('/api/admin/roles', { data: { userId: b.id, tier: 'OBSERVER' } });
    expect(demote.status()).toBe(200);
    const bRow = await prisma.user.findUniqueOrThrow({ where: { id: b.id } });
    expect(bRow.adminLevel).toBe('OBSERVER');
    expect(bRow.sessionsValidFrom!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await prisma.trustedDevice.count({ where: { userId: b.id, revokedAt: null } })).toBe(0);
    const auditRow = await prisma.auditLog.findFirst({ where: { action: 'ADMIN_LEVEL_CHANGE', targetId: b.id } });
    expect(auditRow).toMatchObject({ actorId: a.id, orgId: org.id, detail: 'ORG_ADMIN -> OBSERVER' });
    expect(await prisma.notification.count({ where: { userId: b.id, type: 'admin_tier.changed' } })).toBe(1);
    // B's old token is dead: the next request runs under no session at all.
    expect((await ctxB.get('/api/admin/roles')).status()).toBe(401);

    // An observer cannot assign tiers — not even back to itself.
    const ctxC = await ctxFor(cEmail);
    const escalate = await ctxC.patch('/api/admin/roles', { data: { userId: b.id, tier: 'ORG_ADMIN' } });
    expect(escalate.status()).toBe(403);
    expect((await escalate.json()).code).toBe('permission_denied');
    await ctxC.dispose();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).adminLevel).toBe('OBSERVER');

    // Scope grants: a PROGRAM_ADMIN only, and only this org's cohort.
    expect((await (await ctxA.post('/api/admin/roles', { data: { userId: c.id, cohortId: cohort.id } })).json()).code).toBe('not_program_admin');
    expect((await ctxA.patch('/api/admin/roles', { data: { userId: c.id, tier: 'PROGRAM_ADMIN' } })).status()).toBe(200);
    expect((await ctxA.post('/api/admin/roles', { data: { userId: c.id, cohortId: foreignCohort.id } })).status()).toBe(404);
    const granted = await ctxA.post('/api/admin/roles', { data: { userId: c.id, cohortId: cohort.id } });
    expect(granted.status()).toBe(201);
    const grantId = (await granted.json()).grantId as string;
    expect(await prisma.auditLog.count({ where: { action: 'ADMIN_SCOPE_GRANT', targetId: c.id } })).toBe(1);
    expect((await ctxA.delete(`/api/admin/roles?grantId=${grantId}`)).status()).toBe(200);
    expect(await prisma.adminScopeGrant.count({ where: { userId: c.id } })).toBe(0);

    // A is now the org's only active ORG_ADMIN: deleting the account is refused
    // by the server, although other ADMIN rows (an observer, a program admin) exist.
    const del = await ctxA.delete('/api/account', { data: { currentPassword: PASSWORD } });
    expect(del.status()).toBe(400);
    expect(await prisma.user.count({ where: { id: a.id } })).toBe(1);
  } finally {
    await ctxA.dispose();
    await ctxB.dispose();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: [org.id, other.id] } } }).catch(() => {});
    for (const e of [aEmail, bEmail, cEmail]) await cleanupByEmail(e);
    await prisma.cohort.deleteMany({ where: { id: { in: [cohort.id, foreignCohort.id] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } });
  }
});
