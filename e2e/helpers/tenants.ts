import crypto from 'crypto';
import type { Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './db';
import { signInAsFreshUser } from './auth';
import { roleHome } from '../../src/lib/roleHome';

/**
 * Two fully populated tenants, for tests that run against a server with
 * `MT_ENFORCE_ISOLATION=true` (#1566).
 *
 * WHY THIS EXISTS
 *   Every isolation test written before this one proved something about a
 *   *helper function*, not about the running application:
 *     • `e2e/tenant-isolation.spec.ts` flips `process.env.MT_ENFORCE_ISOLATION`
 *       inside the Playwright process, which the app under test never reads;
 *     • `e2e/org-isolation.spec.ts` calls `orgScoped()` by hand and asserts on
 *       the rows Prisma returns.
 *   Both pass on a server that leaks every row across tenants. The `isolation`
 *   Playwright project (see `playwright.config.ts`) boots a server that really
 *   has the flag on; this fixture gives that project the two tenants it needs
 *   to ask "can A see B?" over HTTP.
 *
 * WHAT IT SEEDS
 *   Two organizations (`iso-a-<stamp>` / `iso-b-<stamp>`), each with an ADMIN, a
 *   MENTOR, a MENTEE and a COMPANY actor plus one row in every model the leak
 *   matrix will probe: Company, MentorshipRelation, Tag, PipelineStage,
 *   InvitationToken and Offer. The two tenants are deliberately symmetric —
 *   every assertion the next task writes can be run in both directions, and a
 *   filter that happens to be right only for the tenant that was seeded first
 *   fails in one of them.
 *
 * WHICH OF THOSE MODELS ARE ACTUALLY ENFORCED TODAY
 *   Only some. `TENANT_MODELS` (`src/lib/orgContext.ts`) is the set the Prisma
 *   middleware auto-scopes; `scripts/check-tenant-models.mjs` (#1560) pins the
 *   rest in its `PENDING_REGISTRATION` ratchet. Of what this fixture seeds:
 *     enforced by the middleware   User, Company, MentorshipRelation
 *     seeded but NOT yet enforced  Tag, PipelineStage, InvitationToken, Offer
 *   The unenforced four are seeded on purpose. They are exactly where a leak is
 *   expected today, so a spec that probes them is documenting a known gap
 *   (#1559 registers them), not reporting a fresh regression — and the day they
 *   are registered, the rows the assertions need are already here.
 *
 * SYNTHETIC ONLY. Everything is minted per run with a random stamp, and
 * `cleanup()` removes it again in FK order. Nothing here reads or copies real
 * data (docs/DATA_ACCESS_POLICY.md), and `prisma/seed-demo.mjs` is deliberately
 * untouched: it is single-org by design.
 */

/** The password every seeded actor signs in with. */
export const TENANT_PASSWORD = 'IsoTenant123!';

export type TenantRole = 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY';

export type TenantActor = {
  id: string;
  email: string;
  fullName: string;
  role: TenantRole;
  /** Always {@link TENANT_PASSWORD}; carried on the actor so sign-in helpers need one argument. */
  password: string;
  /** Where this actor lands after sign-in (`src/lib/roleHome.ts`). */
  landing: string;
};

export type SeededTenant = {
  /** 'A' or 'B' — only for readable assertion messages. */
  label: string;
  org: { id: string; slug: string; name: string };
  admin: TenantActor;
  mentor: TenantActor;
  mentee: TenantActor;
  /** A COMPANY-role user, linked to this tenant's company. */
  companyUser: TenantActor;
  company: { id: string; name: string };
  relation: { id: string };
  tag: { id: string; name: string };
  stage: { id: string; key: string; label: string };
  invitation: { id: string; token: string; email: string };
  offer: { id: string; position: string };
  /** Every actor, in a stable order, for tests that loop over all of them. */
  actors: TenantActor[];
};

export type TwoTenants = {
  orgA: SeededTenant;
  orgB: SeededTenant;
  /** Both org ids, for `where: { orgId: { in: … } }` assertions and teardown. */
  orgIds: string[];
  /** Removes everything this fixture created, in FK order. Idempotent. */
  cleanup: () => Promise<void>;
};

/** Models this fixture writes to, and how to count what is left of them. */
const LEFTOVER_COUNTS = {
  offer: (orgIds: string[]) => prisma.offer.count({ where: { orgId: { in: orgIds } } }),
  tag: (orgIds: string[]) => prisma.tag.count({ where: { orgId: { in: orgIds } } }),
  pipelineStage: (orgIds: string[]) => prisma.pipelineStage.count({ where: { orgId: { in: orgIds } } }),
  invitationToken: (orgIds: string[]) => prisma.invitationToken.count({ where: { orgId: { in: orgIds } } }),
  mentorshipRelation: (orgIds: string[]) => prisma.mentorshipRelation.count({ where: { orgId: { in: orgIds } } }),
  user: (orgIds: string[]) => prisma.user.count({ where: { orgId: { in: orgIds } } }),
  company: (orgIds: string[]) => prisma.company.count({ where: { orgId: { in: orgIds } } }),
  organization: (orgIds: string[]) => prisma.organization.count({ where: { id: { in: orgIds } } }),
} as const;

/**
 * How many rows each seeded model still has for the given orgs.
 *
 * The acceptance criterion for the fixture is "cleans up after itself, leaving
 * no rows behind", and the only honest way to assert that is to ask the
 * database afterwards — a `cleanup()` that silently swallowed a foreign-key
 * error looks identical to one that worked.
 */
export async function remainingTenantRows(orgIds: string[]): Promise<Record<string, number>> {
  const entries = await Promise.all(
    Object.entries(LEFTOVER_COUNTS).map(async ([model, count]) => [model, await count(orgIds)] as const)
  );
  return Object.fromEntries(entries);
}

async function seedActor(
  orgId: string,
  prefix: string,
  role: TenantRole,
  fullName: string,
  companyId?: string
): Promise<TenantActor> {
  const email = uniqueEmail(prefix);
  const user = await seedUser(email, TENANT_PASSWORD, role, fullName);
  await prisma.user.update({
    where: { id: user.id },
    data: { orgId, ...(companyId ? { companyId } : {}) },
  });
  return { id: user.id, email, fullName, role, password: TENANT_PASSWORD, landing: roleHome(role) };
}

async function seedTenant(label: string, slugPrefix: string, stamp: string): Promise<SeededTenant> {
  const name = `Iso ${label}`;
  const org = await prisma.organization.create({
    data: { name: `${name} Org ${stamp}`, slug: `${slugPrefix}-${stamp}` },
  });

  // The company comes first: the COMPANY actor points at it, and the offer
  // needs both it and the relation.
  const company = await prisma.company.create({
    data: { orgId: org.id, name: `${name} Company ${stamp}`, industry: 'Software' },
  });

  const admin = await seedActor(org.id, `iso-${slugPrefix}-admin`, 'ADMIN', `${name} Admin`);
  const mentor = await seedActor(org.id, `iso-${slugPrefix}-mentor`, 'MENTOR', `${name} Mentor`);
  const mentee = await seedActor(org.id, `iso-${slugPrefix}-mentee`, 'MENTEE', `${name} Mentee`);
  const companyUser = await seedActor(
    org.id,
    `iso-${slugPrefix}-company`,
    'COMPANY',
    `${name} Company User`,
    company.id
  );

  const relation = await prisma.mentorshipRelation.create({
    data: {
      orgId: org.id,
      mentorId: mentor.id,
      menteeId: mentee.id,
      companyId: company.id,
      status: 'ACTIVE',
      // Mid-pipeline: a relation parked in the first stage is what the dormant
      // sweep targets and a terminal one is finished — neither is the ordinary
      // in-progress row the boards and the leak matrix are about.
      pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450',
      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    },
  });

  const tag = await prisma.tag.create({
    data: { orgId: org.id, name: `${name} Tag ${stamp}`, color: '#2563eb', createdById: admin.id },
  });

  // A single custom stage, keyed per tenant. Two tenants must be able to hold
  // the SAME stage key without colliding (`@@unique([orgId, key])`), so the key
  // is deliberately not stamped — that is part of what the fixture proves.
  const stage = await prisma.pipelineStage.create({
    data: {
      orgId: org.id,
      key: 'ISO_STAGE',
      label: `${name} Stage`,
      order: 0,
      isTerminal: false,
      isOffPath: false,
    },
  });

  const invitationEmail = uniqueEmail(`iso-${slugPrefix}-invite`);
  const invitation = await prisma.invitationToken.create({
    data: {
      orgId: org.id,
      token: crypto.randomBytes(32).toString('hex'),
      email: invitationEmail,
      role: 'MENTEE',
      invitedById: admin.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  const offer = await prisma.offer.create({
    data: {
      orgId: org.id,
      relationId: relation.id,
      companyId: company.id,
      position: `${name} Intern`,
      status: 'DRAFT',
      createdById: admin.id,
    },
  });

  return {
    label,
    org: { id: org.id, slug: org.slug, name: org.name },
    admin,
    mentor,
    mentee,
    companyUser,
    company: { id: company.id, name: company.name },
    relation: { id: relation.id },
    tag: { id: tag.id, name: tag.name },
    stage: { id: stage.id, key: stage.key, label: stage.label },
    invitation: { id: invitation.id, token: invitation.token, email: invitationEmail },
    offer: { id: offer.id, position: offer.position },
    actors: [admin, mentor, mentee, companyUser],
  };
}

/**
 * Create the two tenants. Call from `test.beforeAll` and `await
 * tenants.cleanup()` from `test.afterAll` — including on failure, or the next
 * run inherits the rows.
 */
export async function seedTwoTenants(): Promise<TwoTenants> {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await seedTenant('A', 'iso-a', stamp);
  const orgB = await seedTenant('B', 'iso-b', stamp);
  const orgIds = [orgA.org.id, orgB.org.id];

  return {
    orgA,
    orgB,
    orgIds,
    cleanup: () => cleanupTenants([orgA, orgB]),
  };
}

/**
 * Teardown, in foreign-key order: the rows that point at other rows go first.
 *
 * Organization → Tag / PipelineStage cascades in the schema and deleting a user
 * takes their relations with them, but relying on that is how a partial failure
 * leaves half a tenant behind. Every step is explicit and every delete is
 * scoped to the seeded org ids, so it can never reach a row this fixture did
 * not create.
 */
async function cleanupTenants(tenants: SeededTenant[]): Promise<void> {
  const orgIds = tenants.map((t) => t.org.id);
  const orgFilter = { orgId: { in: orgIds } };

  // 1. Rows that reference a user, a relation or a company.
  await prisma.offer.deleteMany({ where: orgFilter });
  // UserTag cascades from Tag, so the label rows go with it.
  await prisma.tag.deleteMany({ where: orgFilter });
  await prisma.pipelineStage.deleteMany({ where: orgFilter });
  await prisma.invitationToken.deleteMany({ where: orgFilter });
  await prisma.mentorshipRelation.deleteMany({ where: orgFilter });

  // 2. The users. cleanupByEmail also drops their invitation tokens (matched by
  //    address, which the org-scoped delete above would miss if a spec created
  //    one of its own) and their brute-force lockouts, which carry no FK.
  for (const tenant of tenants) {
    for (const actor of tenant.actors) await cleanupByEmail(actor.email);
    await cleanupByEmail(tenant.invitation.email);
  }
  // Anything a spec added to a tenant — or a user whose delete above was
  // swallowed — must not survive into the organization delete, which would then
  // fail on the foreign key and leave the tenant behind.
  await prisma.user.deleteMany({ where: orgFilter });

  // 3. The tenant's own rows, innermost last.
  await prisma.company.deleteMany({ where: orgFilter });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
}

/**
 * Sign in as one of the fixture's actors and wait for their role landing page.
 *
 * Wraps `signInAsFreshUser` rather than `signInAndSettle`: an isolation spec
 * hops between tenants inside one test, and that helper carries the guards for
 * signing in as a *different* user than the one currently signed in (see the
 * doc comment in `e2e/helpers/auth.ts`).
 */
export async function signInAsTenantActor(page: Page, actor: TenantActor): Promise<void> {
  await signInAsFreshUser(page, actor.email, actor.password, actor.landing);
}
