import { test, expect } from '@playwright/test';
import { prisma } from '../helpers/db';
import { seedTwoTenants, type TwoTenants } from '../helpers/tenants';
import { seedLeakRows, cleanupLeakRows, type LeakTenants } from '../helpers/leakSeed';
import { prisma as appPrisma } from '../../src/lib/prisma';
import { runWithOrg } from '../../src/lib/orgContext';

/**
 * The models the tenant middleware does NOT scope, measured rather than
 * assumed (#1568).
 *
 * `StatusChange`, `InteractionLog`, `Message`, `Goal`, `Evaluation`,
 * `InterviewPanelMember` and `UserTag` have no `orgId`: their tenant is their
 * parent's. The Prisma middleware (`src/lib/orgContext.ts`) only rewrites
 * queries on `TENANT_MODELS`, so a direct `prisma.goal.findMany()` inside
 * `runWithOrg(orgB, …)` still returns tenant A's goals. That is the gap, and
 * this spec pins both halves of it:
 *
 *   1. reached THROUGH the scoped parent (`mentorshipRelation.findMany({
 *      include: { goals } })`, `interviewPanel … members`, `tag … users`), the
 *      children of the other tenant never come back — this is the rule every
 *      route must follow;
 *   2. queried DIRECTLY, they do come back — the measured gap. If one of these
 *      models ever gains an `orgId` and a `TENANT_MODELS` entry
 *      (`npm run check:tenant-models` requires both together), its row here
 *      turns red: move it out of UNSCOPED_CHILDREN, the gap closed.
 *
 * Runs in the Playwright process with the flag set for THIS process — the
 * engine is the same code the server runs, no HTTP involved.
 */

let tenants: TwoTenants;
let rows: LeakTenants;
let prevFlag: string | undefined;

test.beforeAll(async () => {
  prevFlag = process.env.MT_ENFORCE_ISOLATION;
  process.env.MT_ENFORCE_ISOLATION = 'true';
  tenants = await seedTwoTenants();
  rows = await seedLeakRows(tenants);
});

test.afterAll(async () => {
  if (prevFlag === undefined) delete process.env.MT_ENFORCE_ISOLATION;
  else process.env.MT_ENFORCE_ISOLATION = prevFlag;
  if (tenants) {
    await cleanupLeakRows(tenants.orgIds).catch(() => {});
    await tenants.cleanup();
  }
  await appPrisma.$disconnect();
  await prisma.$disconnect();
});

const asB = <T>(fn: () => Promise<T>) => runWithOrg(tenants.orgB.org.id, fn);

test('through the scoped relation, B reaches only its own status changes, interactions, messages, goals and evaluations', async () => {
  const relations = await asB(() =>
    appPrisma.mentorshipRelation.findMany({
      where: { id: { in: [tenants.orgA.relation.id, tenants.orgB.relation.id] } },
      include: { statusChanges: true, interactions: true, messages: true, goals: true, evaluations: true },
    })
  );
  expect(relations.map((r) => r.id), "tenant A's relation came back inside tenant B's scope").toEqual([tenants.orgB.relation.id]);
  const [own] = relations;
  const ids = {
    statusChanges: own.statusChanges.map((x) => x.id),
    interactions: own.interactions.map((x) => x.id),
    messages: own.messages.map((x) => x.id),
    goals: own.goals.map((x) => x.id),
    evaluations: own.evaluations.map((x) => x.id),
  };
  // The control: B's own children are found, so "A's are absent" means scoping.
  expect(ids.statusChanges).toContain(rows.B.statusChange.id);
  expect(ids.interactions).toContain(rows.B.interaction.id);
  expect(ids.messages).toContain(rows.B.message.id);
  expect(ids.goals).toContain(rows.B.goal.id);
  expect(ids.evaluations).toContain(rows.B.evaluation.id);
  expect(ids.statusChanges).not.toContain(rows.A.statusChange.id);
  expect(ids.goals).not.toContain(rows.A.goal.id);
});

test('through the scoped panel and tag, B reaches only its own panel members and tag assignments', async () => {
  const panels = await asB(() =>
    appPrisma.interviewPanel.findMany({
      where: { id: { in: [rows.A.panel.id, rows.B.panel.id] } },
      include: { members: true },
    })
  );
  expect(panels.map((p) => p.id)).toEqual([rows.B.panel.id]);
  expect(panels[0].members.map((m) => m.id)).toEqual([rows.B.panelMember.id]);

  const tags = await asB(() =>
    appPrisma.tag.findMany({ where: { id: { in: [tenants.orgA.tag.id, tenants.orgB.tag.id] } }, include: { users: true } })
  );
  expect(tags.map((t) => t.id)).toEqual([tenants.orgB.tag.id]);
  expect(tags[0].users.map((u) => u.id)).toEqual([rows.B.userTag.id]);
});

// The measured gap: each child model, queried directly inside B's scope, by the
// two ids — A's row is NOT filtered out, because the model has no orgId.
const UNSCOPED_CHILDREN: Array<{ model: string; read: (ids: string[]) => Promise<Array<{ id: string }>>; ids: () => [string, string] }> = [
  { model: 'StatusChange', read: (ids) => appPrisma.statusChange.findMany({ where: { id: { in: ids } } }), ids: () => [rows.A.statusChange.id, rows.B.statusChange.id] },
  { model: 'InteractionLog', read: (ids) => appPrisma.interactionLog.findMany({ where: { id: { in: ids } } }), ids: () => [rows.A.interaction.id, rows.B.interaction.id] },
  { model: 'Message', read: (ids) => appPrisma.message.findMany({ where: { id: { in: ids } } }), ids: () => [rows.A.message.id, rows.B.message.id] },
  { model: 'Goal', read: (ids) => appPrisma.goal.findMany({ where: { id: { in: ids } } }), ids: () => [rows.A.goal.id, rows.B.goal.id] },
  { model: 'Evaluation', read: (ids) => appPrisma.evaluation.findMany({ where: { id: { in: ids } } }), ids: () => [rows.A.evaluation.id, rows.B.evaluation.id] },
  { model: 'InterviewPanelMember', read: (ids) => appPrisma.interviewPanelMember.findMany({ where: { id: { in: ids } } }), ids: () => [rows.A.panelMember.id, rows.B.panelMember.id] },
  { model: 'UserTag', read: (ids) => appPrisma.userTag.findMany({ where: { id: { in: ids } } }), ids: () => [rows.A.userTag.id, rows.B.userTag.id] },
];

for (const child of UNSCOPED_CHILDREN) {
  test(`${child.model} is not auto-scoped: a direct read must go through its parent`, async () => {
    const [a, b] = child.ids();
    const found = (await asB(() => child.read([a, b]))).map((r) => r.id);
    test.info().annotations.push({ type: 'tenant-gap', description: `${child.model}: direct read inside B's scope returned ${found.length} of 2 rows` });
    expect(found).toContain(b);
    expect(
      found,
      `${child.model} is now scoped by the middleware — the gap closed. Move it out of UNSCOPED_CHILDREN ` +
        'in e2e/isolation/uncovered-models.spec.ts and into the leak matrix.'
    ).toContain(a);
  });
}

test('the registered parents really are scoped in this process (the spec is not vacuous)', async () => {
  // If the flag did not take in this process every parent assertion above
  // would fail anyway — this names the cause instead.
  const companies = await asB(() =>
    appPrisma.company.findMany({ where: { id: { in: [tenants.orgA.company.id, tenants.orgB.company.id] } } })
  );
  expect(companies.map((c) => c.id), 'MT_ENFORCE_ISOLATION did not take effect in the Playwright process').toEqual([tenants.orgB.company.id]);
});
