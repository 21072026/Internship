import { test, expect } from '@playwright/test';
import { prisma } from '../helpers/db';
import {
  seedTwoTenants,
  signInAsTenantActor,
  remainingTenantRows,
  type TwoTenants,
} from '../helpers/tenants';

/**
 * The fixture's own tests (#1566).
 *
 * `e2e/helpers/tenants.ts` is about to be the foundation every cross-tenant
 * assertion stands on, so it gets the same treatment as the app: if it seeds a
 * tenant that is missing a row, the leak matrix probes an empty table and
 * reports "no leak" for a model nobody tested. And if it fails to tear a tenant
 * down, the next run's `@@unique([orgId, key])` collisions and stray
 * `iso-*@e2e.local` users are somebody's afternoon.
 */

let tenants: TwoTenants;

test.beforeAll(async () => {
  tenants = await seedTwoTenants();
});

test.afterAll(async () => {
  await tenants?.cleanup();
  await prisma.$disconnect();
});

test('both tenants are fully populated and separate', async () => {
  const { orgA, orgB } = tenants;

  // Distinct tenants, distinct rows — nothing is shared by accident.
  expect(orgA.org.id).not.toBe(orgB.org.id);
  expect(orgA.org.slug).not.toBe(orgB.org.slug);
  expect(orgA.company.id).not.toBe(orgB.company.id);

  for (const tenant of [orgA, orgB]) {
    const orgId = tenant.org.id;

    // Four actors, one per role, all anchored to this tenant.
    const users = await prisma.user.findMany({ where: { orgId }, select: { id: true, role: true } });
    expect(users.map((u) => u.role).sort()).toEqual(['ADMIN', 'COMPANY', 'MENTEE', 'MENTOR']);
    // The COMPANY actor observes this tenant's company, not some other one.
    const companyUser = await prisma.user.findUnique({
      where: { id: tenant.companyUser.id },
      select: { companyId: true },
    });
    expect(companyUser?.companyId).toBe(tenant.company.id);

    // One row in every model the leak matrix will probe.
    expect(await prisma.company.count({ where: { orgId } })).toBe(1);
    expect(await prisma.mentorshipRelation.count({ where: { orgId } })).toBe(1);
    expect(await prisma.tag.count({ where: { orgId } })).toBe(1);
    expect(await prisma.pipelineStage.count({ where: { orgId } })).toBe(1);
    expect(await prisma.invitationToken.count({ where: { orgId } })).toBe(1);
    expect(await prisma.offer.count({ where: { orgId } })).toBe(1);
  }

  // The two tenants hold the SAME pipeline stage key. `@@unique([orgId, key])`
  // means that is legal, and it is the shape a scoping bug shows up in: a lookup
  // by key alone resolves to whichever row the database happened to return.
  expect(orgA.stage.key).toBe(orgB.stage.key);
  expect(orgA.stage.id).not.toBe(orgB.stage.id);
});

test('every actor in both tenants can sign in', async ({ page }) => {
  // Eight sign-ins through the real form, one after another. Slow, and worth
  // it: a seeded user who cannot actually authenticate (a role the sign-in path
  // rejects, an address the email input refuses — see `uniqueEmail`) is a
  // failure the leak matrix would report as "no access", i.e. as a pass.
  test.setTimeout(240_000);

  for (const tenant of [tenants.orgA, tenants.orgB]) {
    for (const actor of tenant.actors) {
      await signInAsTenantActor(page, actor);
      expect(page.url(), `${actor.role} of tenant ${tenant.label} landed elsewhere`)
        .toContain(actor.landing);
    }
  }
});

test('cleanup() leaves nothing behind', async () => {
  // A second, throwaway pair: asserting on the shared one would pull the rug
  // out from under the tests above (Playwright's file order is not a contract).
  const throwaway = await seedTwoTenants();
  const orgIds = throwaway.orgIds;

  // Exact counts rather than "more than zero": a fixture that quietly stopped
  // seeding one of the models would still satisfy the loose version, and the
  // model it stopped seeding is the one nobody would then be testing.
  expect(await remainingTenantRows(orgIds)).toEqual({
    offer: 2,
    tag: 2,
    pipelineStage: 2,
    invitationToken: 2,
    mentorshipRelation: 2,
    user: 8,
    company: 2,
    organization: 2,
  });

  await throwaway.cleanup();
  const after = await remainingTenantRows(orgIds);
  expect(after).toEqual(Object.fromEntries(Object.keys(after).map((model) => [model, 0])));

  // Idempotent: a spec that cleans up after a failed assertion AND again in
  // `afterAll` must not blow up on the second call.
  await throwaway.cleanup();
  expect(await remainingTenantRows(orgIds)).toEqual(after);
});
