import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { prisma as appPrisma } from '../src/lib/prisma';
import { runWithOrg } from '../src/lib/orgContext';

/**
 * The eight late registrations (#1559) — proved one model at a time.
 *
 * WHAT THIS ASSERTS AND WHY IT IS SHAPED LIKE THIS
 *   `Tag`, `StageSla`, `PipelineStage`, `CompanyInquiry`, `Offer`,
 *   `InterviewPanel`, `EvaluationTemplate` and `InvitationToken` all carried an
 *   `orgId` for months without being listed in `TENANT_MODELS`
 *   (src/lib/orgContext.ts). An unregistered model is a *silent* pass-through:
 *   the middleware never matches it, so the row looked scoped while it was
 *   protected only by whatever `where` clause the last developer wrote.
 *
 *   Registration is therefore not provable from a route response — a handler
 *   that happens to pass an explicit `orgId` filter answers correctly whether or
 *   not the model is registered. The only assertion that separates the two is a
 *   query with NO tenant filter of its own, run against the app's own Prisma
 *   client inside `runWithOrg()`: it returns one tenant's row if and only if the
 *   middleware saw the model. So every probe below queries by
 *   `id: { in: [A, B] }` and by nothing else.
 *
 *   Both directions, every model. A filter accidentally pinned to one tenant —
 *   the first one seeded, a stale closure — passes one direction and fails the
 *   other, and only asking both makes a pass mean "scoped by the bound org".
 *
 *   The last test is the control: with `MT_ENFORCE_ISOLATION` off, the very same
 *   queries return BOTH rows. Without it, a seed that quietly stopped writing
 *   one tenant's row would satisfy every assertion above while testing nothing.
 *
 * WHY IT RUNS IN THE DEFAULT PROJECT
 *   Like `e2e/tenant-isolation.spec.ts`, this speaks to Prisma directly and
 *   flips the flag in the Playwright process, so it needs no server with the
 *   flag on. The `isolation` project (#1566) covers the over-HTTP half.
 *
 * SYNTHETIC ONLY: two throwaway orgs minted per run, removed in FK order.
 */

type SeededOrg = {
  orgId: string;
  emails: string[];
  tag: string;
  stageSla: string;
  pipelineStage: string;
  companyInquiry: string;
  offer: string;
  interviewPanel: string;
  evaluationTemplate: string;
  invitationToken: string;
};

/** One row of every one of the eight models, all anchored to a fresh org. */
async function seedOrg(label: string, stamp: string): Promise<SeededOrg> {
  const org = await prisma.organization.create({
    data: { name: `MT ${label} ${stamp}`, slug: `mt-${label}-${stamp}` },
  });
  const mentor = await seedUser(uniqueEmail(`mt-${label}-mentor`), 'x', 'MENTOR', `MT ${label} Mentor`);
  const mentee = await seedUser(uniqueEmail(`mt-${label}-mentee`), 'x', 'MENTEE', `MT ${label} Mentee`);
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id] } }, data: { orgId: org.id } });

  const relation = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id },
  });

  // Deliberately the SAME natural keys in both tenants (`Tag.name`,
  // `PipelineStage.key`, `StageSla.stageKey`): each model's `@@unique` is scoped
  // by orgId, so that is legal — and it is the shape a scoping bug appears in,
  // because a lookup by the key alone resolves to whichever row the database
  // happened to return.
  const tag = await prisma.tag.create({ data: { orgId: org.id, name: 'Shared Label' } });
  const stageSla = await prisma.stageSla.create({
    data: { orgId: org.id, stageKey: 'APPLICATION_100', days: 5 },
  });
  const pipelineStage = await prisma.pipelineStage.create({
    data: { orgId: org.id, key: 'APPLICATION_100', label: `MT ${label} Application`, order: 0 },
  });
  const companyInquiry = await prisma.companyInquiry.create({
    data: {
      orgId: org.id,
      companyName: `MT ${label} Co`,
      contactName: `MT ${label} Contact`,
      email: uniqueEmail(`mt-${label}-inquiry`),
    },
  });
  const offer = await prisma.offer.create({
    data: {
      orgId: org.id,
      relationId: relation.id,
      position: `MT ${label} Intern`,
      status: 'DRAFT',
      createdById: mentor.id,
    },
  });
  const interviewPanel = await prisma.interviewPanel.create({
    data: { orgId: org.id, subjectId: mentee.id, title: `MT ${label} Panel`, createdById: mentor.id },
  });
  const evaluationTemplate = await prisma.evaluationTemplate.create({
    data: { orgId: org.id, name: `MT ${label} Rubric`, scope: 'MENTEE' },
  });
  const invitationToken = await prisma.invitationToken.create({
    data: {
      orgId: org.id,
      token: crypto.randomBytes(32).toString('hex'),
      email: uniqueEmail(`mt-${label}-invite`),
      role: 'MENTEE',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return {
    orgId: org.id,
    emails: [mentor.email, mentee.email],
    tag: tag.id,
    stageSla: stageSla.id,
    pipelineStage: pipelineStage.id,
    companyInquiry: companyInquiry.id,
    offer: offer.id,
    interviewPanel: interviewPanel.id,
    evaluationTemplate: evaluationTemplate.id,
    invitationToken: invitationToken.id,
  };
}

/**
 * Teardown, in foreign-key order, through the HELPER client.
 *
 * Not the app client: the middleware installs itself on that one the first time
 * `runWithOrg` runs with the flag on and stays installed for the life of the
 * worker. A teardown that ran through it would be at the mercy of whatever
 * context happened to be bound — and a delete that silently matches nothing
 * leaves a whole tenant behind.
 */
async function removeOrg(seeded: SeededOrg | undefined): Promise<void> {
  if (!seeded) return;
  const where = { orgId: { in: [seeded.orgId] } };
  await prisma.offer.deleteMany({ where });
  await prisma.interviewPanel.deleteMany({ where });
  await prisma.evaluationTemplate.deleteMany({ where });
  await prisma.tag.deleteMany({ where });
  await prisma.stageSla.deleteMany({ where });
  await prisma.pipelineStage.deleteMany({ where });
  await prisma.companyInquiry.deleteMany({ where });
  await prisma.invitationToken.deleteMany({ where });
  await prisma.mentorshipRelation.deleteMany({ where });
  for (const email of seeded.emails) await cleanupByEmail(email);
  await prisma.user.deleteMany({ where });
  await prisma.organization.deleteMany({ where: { id: seeded.orgId } });
}

/**
 * One probe per model: a read with no tenant filter of its own.
 *
 * `read` is what a handler that forgot to scope would run, so the middleware is
 * the only thing that can narrow it. `idOf` picks that model's row out of a
 * seeded tenant.
 */
const PROBES: {
  model: string;
  read: (ids: string[]) => Promise<{ id: string }[]>;
  idOf: (o: SeededOrg) => string;
}[] = [
  {
    model: 'Tag',
    read: (ids) => appPrisma.tag.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    idOf: (o) => o.tag,
  },
  {
    model: 'StageSla',
    read: (ids) => appPrisma.stageSla.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    idOf: (o) => o.stageSla,
  },
  {
    model: 'PipelineStage',
    read: (ids) => appPrisma.pipelineStage.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    idOf: (o) => o.pipelineStage,
  },
  {
    model: 'CompanyInquiry',
    read: (ids) => appPrisma.companyInquiry.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    idOf: (o) => o.companyInquiry,
  },
  {
    model: 'Offer',
    read: (ids) => appPrisma.offer.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    idOf: (o) => o.offer,
  },
  {
    model: 'InterviewPanel',
    read: (ids) => appPrisma.interviewPanel.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    idOf: (o) => o.interviewPanel,
  },
  {
    model: 'EvaluationTemplate',
    read: (ids) => appPrisma.evaluationTemplate.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    idOf: (o) => o.evaluationTemplate,
  },
  {
    model: 'InvitationToken',
    read: (ids) => appPrisma.invitationToken.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    idOf: (o) => o.invitationToken,
  },
];

let orgA: SeededOrg | undefined;
let orgB: SeededOrg | undefined;
let flagBefore: string | undefined;

test.beforeAll(async () => {
  flagBefore = process.env.MT_ENFORCE_ISOLATION;
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  // Seeded with the flag OFF, so the middleware cannot rewrite the creates and
  // every row provably carries the orgId this file passed it.
  delete process.env.MT_ENFORCE_ISOLATION;
  orgA = await seedOrg('a', stamp);
  orgB = await seedOrg('b', stamp);
});

test.afterAll(async () => {
  delete process.env.MT_ENFORCE_ISOLATION;
  await removeOrg(orgA).catch(() => {});
  await removeOrg(orgB).catch(() => {});
  if (flagBefore !== undefined) process.env.MT_ENFORCE_ISOLATION = flagBefore;
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test('every late-registered model is scoped to the bound org, in both directions', async () => {
  process.env.MT_ENFORCE_ISOLATION = 'true';
  try {
    for (const probe of PROBES) {
      const idA = probe.idOf(orgA!);
      const idB = probe.idOf(orgB!);

      const seenByA = await runWithOrg(orgA!.orgId, () => probe.read([idA, idB]));
      expect(
        seenByA.map((r) => r.id),
        `${probe.model}: a query with no tenant filter, bound to org A, returned something other ` +
          `than exactly A's row — ${probe.model} is missing from TENANT_MODELS in src/lib/orgContext.ts`
      ).toEqual([idA]);

      const seenByB = await runWithOrg(orgB!.orgId, () => probe.read([idA, idB]));
      expect(
        seenByB.map((r) => r.id),
        `${probe.model}: scoping holds for org A but not for org B — the filter is pinned to one ` +
          'tenant rather than derived from the bound context'
      ).toEqual([idB]);
    }
  } finally {
    delete process.env.MT_ENFORCE_ISOLATION;
  }
});

test('a bound context with no org does not scope (sessionless paths keep working)', async () => {
  // `runWithOrg(null, …)` is the state of every unauthenticated path:
  // registration and invite acceptance look a row up BY TOKEN, with no tenant to
  // resolve. The middleware reads "no org" as "do not scope", and that is what
  // keeps an invitation usable by the person it was sent to once the flag is on.
  process.env.MT_ENFORCE_ISOLATION = 'true';
  try {
    const both = [orgA!.invitationToken, orgB!.invitationToken];
    const seen = await runWithOrg(null, () =>
      appPrisma.invitationToken.findMany({ where: { id: { in: both } }, select: { id: true } })
    );
    expect(seen.map((r) => r.id).sort()).toEqual([...both].sort());
  } finally {
    delete process.env.MT_ENFORCE_ISOLATION;
  }
});

test('with enforcement off the same queries see both tenants (the control)', async () => {
  // Two things at once: single-tenant production is unchanged by the
  // registration, and the assertions above are not passing because the seed is
  // empty or half-written.
  delete process.env.MT_ENFORCE_ISOLATION;
  for (const probe of PROBES) {
    const both = [probe.idOf(orgA!), probe.idOf(orgB!)];
    const seen = await runWithOrg(orgA!.orgId, () => probe.read(both));
    expect(
      seen.map((r) => r.id).sort(),
      `${probe.model}: with MT_ENFORCE_ISOLATION off this read must return both rows — if it does ` +
        'not, the seed never wrote one of them and the scoped assertions above prove nothing'
    ).toEqual([...both].sort());
  }
});
