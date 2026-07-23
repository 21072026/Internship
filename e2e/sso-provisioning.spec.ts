import { test, expect } from '@playwright/test';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';
import { provisionSsoUser } from '../src/lib/ssoProvisioning';

// JIT provisioning for Enterprise SSO (#545). Proves a verified IdP identity maps
// to a User in the correct tenant + role — the testable half of #545, exercised
// against a real DB without a live IdP. Runs with isolation enforcement off so
// the helper's cross-tenant email lookup is unscoped (as the SSO callback path
// will arrange).
test.beforeAll(() => { delete process.env.MT_ENFORCE_ISOLATION; });
test.afterAll(async () => { await prisma.$disconnect(); });

test('JIT-provisions a new user into the correct tenant with default MENTEE role', async () => {
  const stamp = uniqueEmail('sso').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({ data: { name: `SSO Org ${stamp}`, slug: `sso-${stamp}` } });
  const email = uniqueEmail('sso-new');
  try {
    const { user, created } = await provisionSsoUser({ orgId: org.id, email, fullName: 'SSO New' });
    expect(created).toBe(true);
    expect(user.orgId).toBe(org.id);
    expect(user.role).toBe('MENTEE');
    const row = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    expect(row?.emailVerified).not.toBeNull();

    // Idempotent: a second login returns the same user, does not duplicate.
    const again = await provisionSsoUser({ orgId: org.id, email, fullName: 'SSO New' });
    expect(again.created).toBe(false);
    expect(again.user.id).toBe(user.id);
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

test('respects an IdP-mapped role', async () => {
  const stamp = uniqueEmail('sso').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({ data: { name: `SSO Org ${stamp}`, slug: `ssor-${stamp}` } });
  const email = uniqueEmail('sso-mentor');
  try {
    const { user } = await provisionSsoUser({ orgId: org.id, email, role: 'MENTOR' });
    expect(user.role).toBe('MENTOR');
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

test('adopts a not-yet-tenanted user, and refuses cross-tenant reuse', async () => {
  const stamp = uniqueEmail('sso').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const orgA = await prisma.organization.create({ data: { name: `SSO A ${stamp}`, slug: `ssoa-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `SSO B ${stamp}`, slug: `ssob-${stamp}` } });
  const email = uniqueEmail('sso-adopt');
  try {
    // Pre-existing user with no org (single-tenant/default) → adopted into org A.
    const seeded = await prisma.user.create({
      data: { email: email.toLowerCase(), password: 'x', role: 'MENTEE', fullName: 'Adopt Me', skills: [] },
    });
    expect(seeded.orgId).toBeNull();

    const { user, created } = await provisionSsoUser({ orgId: orgA.id, email });
    expect(created).toBe(false);
    expect(user.orgId).toBe(orgA.id);

    // Same email now belongs to org A → an org B IdP must not steal it.
    await expect(provisionSsoUser({ orgId: orgB.id, email })).rejects.toThrow(/different organization/);
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
