import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';
import { prisma as appPrisma } from '../src/lib/prisma';
import { runWithOrg } from '../src/lib/orgContext';
import { listRetentionEntries } from '../src/lib/retentionPrune';
import { pruneDomainEvents } from '../src/lib/retentionEntries';

/**
 * The DomainEvent record (#1691): tenant data, and pruned by the one registry.
 *
 * The scoping probe follows e2e/tenant-models-registered.spec.ts: a read with
 * NO tenant filter of its own, through the app client inside `runWithOrg()`,
 * returns one tenant's row only if the middleware knows the model — asked in
 * both directions, with the flag-off control showing both rows exist.
 *
 * The prune half asserts the sweep crosses tenants (it runs with no session)
 * and stops at the cutoff. SYNTHETIC ONLY: two throwaway orgs per run.
 */

type Seeded = { orgId: string; fresh: string; old: string };

const DAY = 24 * 60 * 60 * 1000;

async function seed(label: string, stamp: string): Promise<Seeded> {
  const org = await prisma.organization.create({ data: { name: `DE ${label} ${stamp}`, slug: `de-${label}-${stamp}` } });
  const base = {
    orgId: org.id,
    name: 'pipeline.stage_change',
    version: 1,
    payload: { relationId: `rel-${label}`, from: 'APPLICATION_100', to: 'APPROVAL_PENDING_220' },
    actorType: 'system',
    subjectType: 'MentorshipRelation',
    subjectId: `rel-${label}`,
  };
  const fresh = await prisma.domainEvent.create({ data: base });
  const old = await prisma.domainEvent.create({ data: { ...base, createdAt: new Date(Date.now() - 400 * DAY) } });
  return { orgId: org.id, fresh: fresh.id, old: old.id };
}

let a: Seeded | undefined;
let b: Seeded | undefined;
let flagBefore: string | undefined;

test.beforeAll(async () => {
  flagBefore = process.env.MT_ENFORCE_ISOLATION;
  delete process.env.MT_ENFORCE_ISOLATION;
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  a = await seed('a', stamp);
  b = await seed('b', stamp);
});

test.afterAll(async () => {
  delete process.env.MT_ENFORCE_ISOLATION;
  const ids = [a?.orgId, b?.orgId].filter((x): x is string => !!x);
  await prisma.domainEvent.deleteMany({ where: { orgId: { in: ids } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  if (flagBefore !== undefined) process.env.MT_ENFORCE_ISOLATION = flagBefore;
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

const read = (ids: string[]) =>
  appPrisma.domainEvent.findMany({ where: { id: { in: ids } }, select: { id: true }, orderBy: { id: 'asc' } });

test('a DomainEvent read with no tenant filter sees only the bound org, both ways', { tag: '@smoke' }, async () => {
  const ids = [a!.fresh, b!.fresh];
  // Control: with the flag off both rows are there to be filtered.
  expect((await runWithOrg(a!.orgId, () => read(ids))).length).toBe(2);

  process.env.MT_ENFORCE_ISOLATION = 'true';
  try {
    expect((await runWithOrg(a!.orgId, () => read(ids))).map((r) => r.id), 'DomainEvent missing from TENANT_MODELS').toEqual([
      a!.fresh,
    ]);
    expect((await runWithOrg(b!.orgId, () => read(ids))).map((r) => r.id)).toEqual([b!.fresh]);
  } finally {
    delete process.env.MT_ENFORCE_ISOLATION;
  }
});

test('the domainEvent retention entry is registered and prunes every tenant up to the cutoff', async () => {
  const entry = listRetentionEntries().find((e) => e.key === 'domainEvent');
  expect(entry?.settingKey).toBe('domainEventRetentionDays');
  expect(entry?.defaultDays).toBe(90);

  const all = [a!.fresh, a!.old, b!.fresh, b!.old];
  // Large budget, small batches: both tenants' old rows go (other suites' rows
  // older than a year may go too — that is the entry doing its job).
  const outcome = await pruneDomainEvents(new Date(Date.now() - 90 * DAY), { batchSize: 1, budget: 10_000 });
  expect(outcome.deleted).toBeGreaterThanOrEqual(2);
  const left = await prisma.domainEvent.findMany({ where: { id: { in: all } }, select: { id: true } });
  expect(left.map((r) => r.id).sort()).toEqual([a!.fresh, b!.fresh].sort());
});
