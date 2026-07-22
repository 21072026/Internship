import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { orgScoped, assertSameOrg, requireOrg, isIsolationEnforced } from '../src/lib/orgScope';
import { prisma as appPrisma } from '../src/lib/prisma';
import { runWithOrg } from '../src/lib/orgContext';

// Tenant isolation building blocks (#543). These prove that the orgScope
// helpers genuinely separate two tenants at the DB level — the guarantee the
// guarded MT_ENFORCE_ISOLATION rollout depends on. They exercise the helpers +
// Prisma directly (no HTTP), so they pass regardless of the server's flag.
test.afterAll(async () => {
  await prisma.$disconnect();
});

test('orgScoped isolates one tenant’s relations from another’s', async () => {
  const stamp = uniqueEmail('iso').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const orgA = await prisma.organization.create({ data: { name: `Org A ${stamp}`, slug: `orga-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `Org B ${stamp}`, slug: `orgb-${stamp}` } });

  const mentorA = await seedUser(uniqueEmail('iso-mentorA'), 'x', 'MENTOR', 'Iso MentorA');
  const menteeA = await seedUser(uniqueEmail('iso-menteeA'), 'x', 'MENTEE', 'Iso MenteeA');
  const mentorB = await seedUser(uniqueEmail('iso-mentorB'), 'x', 'MENTOR', 'Iso MentorB');
  const menteeB = await seedUser(uniqueEmail('iso-menteeB'), 'x', 'MENTEE', 'Iso MenteeB');

  const relA = await prisma.mentorshipRelation.create({ data: { mentorId: mentorA.id, menteeId: menteeA.id, orgId: orgA.id } });
  const relB = await prisma.mentorshipRelation.create({ data: { mentorId: mentorB.id, menteeId: menteeB.id, orgId: orgB.id } });

  try {
    // Scoped to A → only A's relation; B is invisible.
    const seenByA = await prisma.mentorshipRelation.findMany({
      where: orgScoped({ id: { in: [relA.id, relB.id] } }, orgA.id),
    });
    expect(seenByA.map((r) => r.id)).toEqual([relA.id]);
    expect(seenByA.some((r) => r.id === relB.id)).toBe(false);

    // Scoped to B → only B's relation.
    const seenByB = await prisma.mentorshipRelation.findMany({
      where: orgScoped({ id: { in: [relA.id, relB.id] } }, orgB.id),
    });
    expect(seenByB.map((r) => r.id)).toEqual([relB.id]);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [relA.id, relB.id] } } });
    await cleanupByEmail(mentorA.email); await cleanupByEmail(menteeA.email);
    await cleanupByEmail(mentorB.email); await cleanupByEmail(menteeB.email);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});

test('assertSameOrg blocks cross-tenant access when enforcement is on', () => {
  const prev = process.env.MT_ENFORCE_ISOLATION;
  process.env.MT_ENFORCE_ISOLATION = 'true';
  try {
    expect(isIsolationEnforced()).toBe(true);
    // Same tenant → allowed.
    expect(() => assertSameOrg('org-1', 'org-1')).not.toThrow();
    // Cross tenant → denied.
    expect(() => assertSameOrg('org-2', 'org-1')).toThrow(/Cross-tenant/);
    // requireOrg fails closed when no org resolves under enforcement.
    expect(() => requireOrg({ user: {} } as never)).toThrow(/enforced/);
    // Resolves the org when present.
    expect(requireOrg({ user: { orgId: 'org-9' } } as never)).toBe('org-9');
  } finally {
    process.env.MT_ENFORCE_ISOLATION = prev;
  }
});

test('with enforcement off, helpers are no-ops (single-tenant unchanged)', () => {
  const prev = process.env.MT_ENFORCE_ISOLATION;
  delete process.env.MT_ENFORCE_ISOLATION;
  try {
    expect(isIsolationEnforced()).toBe(false);
    // No throw even across "different" orgs when the flag is off.
    expect(() => assertSameOrg('org-2', 'org-1')).not.toThrow();
    // requireOrg returns null instead of throwing.
    expect(requireOrg({ user: {} } as never)).toBeNull();
  } finally {
    if (prev !== undefined) process.env.MT_ENFORCE_ISOLATION = prev;
  }
});

// The central middleware (#543) is the "can't forget the filter" guarantee: a
// query that NEVER calls orgScoped() is still isolated, purely because it ran
// inside runWithOrg() with enforcement on. This is what makes criterion 1 —
// "every tenant-scoped query returns only its tenant's data" — hold app-wide.
test('central middleware auto-scopes a plain (non-orgScoped) query under runWithOrg', async () => {
  const stamp = uniqueEmail('mw').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const orgA = await prisma.organization.create({ data: { name: `MW A ${stamp}`, slug: `mwa-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `MW B ${stamp}`, slug: `mwb-${stamp}` } });

  // Seed with the plain helper client (no middleware) so seeding is never scoped.
  const emailA = uniqueEmail('mw-a');
  const emailB = uniqueEmail('mw-b');
  const userA = await prisma.user.create({ data: { email: emailA, password: 'x', role: 'MENTEE', fullName: 'MW A', skills: [], orgId: orgA.id } });
  const userB = await prisma.user.create({ data: { email: emailB, password: 'x', role: 'MENTEE', fullName: 'MW B', skills: [], orgId: orgB.id } });

  const prev = process.env.MT_ENFORCE_ISOLATION;
  const ids = { id: { in: [userA.id, userB.id] } };
  try {
    process.env.MT_ENFORCE_ISOLATION = 'true';

    // Plain findMany — NO orgScoped() — bound to org A sees only A's user.
    const seenByA = await runWithOrg(orgA.id, () => appPrisma.user.findMany({ where: ids }));
    expect(seenByA.map((u) => u.id)).toEqual([userA.id]);

    const seenByB = await runWithOrg(orgB.id, () => appPrisma.user.findMany({ where: ids }));
    expect(seenByB.map((u) => u.id)).toEqual([userB.id]);

    // findUnique across tenants returns null (extendedWhereUnique + orgId).
    const crossTenant = await runWithOrg(orgB.id, () => appPrisma.user.findUnique({ where: { id: userA.id } }));
    expect(crossTenant).toBeNull();

    // create auto-stamps the bound org even when data omits orgId.
    const emailC = uniqueEmail('mw-c');
    const created = await runWithOrg(orgA.id, () =>
      appPrisma.user.create({ data: { email: emailC, password: 'x', role: 'MENTEE', fullName: 'MW C', skills: [] } })
    );
    expect(created.orgId).toBe(orgA.id);
    await prisma.user.delete({ where: { id: created.id } });

    // Flag OFF: the same bound query is a no-op — both tenants are visible.
    process.env.MT_ENFORCE_ISOLATION = 'false';
    const seenBoth = await runWithOrg(orgA.id, () => appPrisma.user.findMany({ where: ids }));
    expect(seenBoth.map((u) => u.id).sort()).toEqual([userA.id, userB.id].sort());
  } finally {
    if (prev === undefined) delete process.env.MT_ENFORCE_ISOLATION;
    else process.env.MT_ENFORCE_ISOLATION = prev;
    await cleanupByEmail(emailA);
    await cleanupByEmail(emailB);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await appPrisma.$disconnect();
  }
});
