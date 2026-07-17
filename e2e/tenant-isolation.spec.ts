import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { orgScoped, assertSameOrg, requireOrg, isIsolationEnforced } from '../src/lib/orgScope';

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
