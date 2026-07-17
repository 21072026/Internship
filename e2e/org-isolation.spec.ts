import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';
import {
  orgScoped, resolveOrgId, requireOrg, assertSameOrg, isIsolationEnforced,
} from '../src/lib/orgScope';

// Multi-tenancy enforcement building blocks (#543). Global auto-isolation is NOT
// switched on (MT_ENFORCE_ISOLATION defaults off), so these tests validate the
// opt-in scoping helper against a real DB plus the guard semantics — proving the
// path works before it is wired app-wide. See docs/tenant-isolation.md.

const slugs = ['iso-a', 'iso-b'].map((s) => `${s}-${Date.now()}`);

test.afterAll(async () => {
  // Remove seeded users first (FK), then the orgs.
  for (const slug of slugs) {
    const org = await prisma.organization.findUnique({ where: { slug } });
    if (org) {
      await prisma.user.deleteMany({ where: { orgId: org.id } });
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
    }
  }
  await prisma.$disconnect();
});

test('orgScoped() filters queries to a single tenant', async () => {
  const [slugA, slugB] = slugs;
  const orgA = await prisma.organization.create({ data: { name: 'Iso A', slug: slugA } });
  const orgB = await prisma.organization.create({ data: { name: 'Iso B', slug: slugB } });

  const mk = (org: string, tag: string) => prisma.user.create({
    data: {
      email: `iso-${tag}-${Date.now()}-${Math.round(performance.now())}@e2e.local`,
      password: 'x', role: 'MENTEE', fullName: `Iso ${tag}`, skills: [], orgId: org,
    },
  });
  await mk(orgA.id, 'a1');
  await mk(orgA.id, 'a2');
  await mk(orgB.id, 'b1');

  // Scoped query returns only the requested tenant's rows.
  const aRows = await prisma.user.findMany({ where: orgScoped({ role: 'MENTEE' as const }, orgA.id) });
  expect(aRows.length).toBe(2);
  expect(aRows.every((u) => u.orgId === orgA.id)).toBe(true);

  const bRows = await prisma.user.findMany({ where: orgScoped({ role: 'MENTEE' as const }, orgB.id) });
  expect(bRows.length).toBe(1);
  expect(bRows[0].orgId).toBe(orgB.id);

  // A null orgId means "no scoping" — the helper leaves the where unchanged.
  const scoped = orgScoped({ role: 'MENTEE' as const }, null);
  expect(scoped).not.toHaveProperty('orgId');
});

test('guards fail-closed only when enforcement is on', async () => {
  const session = (orgId: string | null) => ({ user: { orgId } }) as unknown as Parameters<typeof resolveOrgId>[0];

  expect(resolveOrgId(session('org-1'))).toBe('org-1');
  expect(resolveOrgId(session(null))).toBeNull();
  expect(resolveOrgId(null)).toBeNull();

  const prev = process.env.MT_ENFORCE_ISOLATION;
  try {
    // Enforcement OFF (default): no-ops, never throws.
    process.env.MT_ENFORCE_ISOLATION = 'false';
    expect(isIsolationEnforced()).toBe(false);
    expect(requireOrg(session(null))).toBeNull();
    expect(() => assertSameOrg('org-2', 'org-1')).not.toThrow();

    // Enforcement ON: requireOrg throws with no org; assertSameOrg blocks mismatch.
    process.env.MT_ENFORCE_ISOLATION = 'true';
    expect(isIsolationEnforced()).toBe(true);
    expect(requireOrg(session('org-1'))).toBe('org-1');
    expect(() => requireOrg(session(null))).toThrow();
    expect(() => assertSameOrg('org-1', 'org-1')).not.toThrow();
    expect(() => assertSameOrg('org-2', 'org-1')).toThrow();
  } finally {
    if (prev === undefined) delete process.env.MT_ENFORCE_ISOLATION;
    else process.env.MT_ENFORCE_ISOLATION = prev;
  }
});
