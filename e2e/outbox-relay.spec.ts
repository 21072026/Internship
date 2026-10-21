import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { prisma as appPrisma } from '../src/lib/prisma';
import { runWithOrg } from '../src/lib/orgContext';
import { InvalidEventError, domainEventData, publishEvent, publishEventOp } from '../src/lib/events/publish';
import { relayOnce } from '../src/lib/events/relay';
import { clearSubscriberRegistry, deliveryKey, registerSubscriberEvents } from '../src/lib/events/subscribers';

/**
 * The transactional outbox (#1680).
 *
 * The event row commits with the write it describes or not at all, and the
 * relay turns a committed row into exactly one job per subscriber, in
 * per-subject order, with no session (and with MT_ENFORCE_ISOLATION on).
 *
 * The e2e servers run with EVENTS_RELAY_ENABLED=0 (playwright.config.ts), so
 * nothing but this spec relays. It speaks to Prisma directly, like
 * tenant-models-registered.spec.ts; the route half goes over HTTP.
 * SYNTHETIC ONLY: throwaway orgs and accounts, removed afterwards.
 */

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const orgIds: string[] = [];
const emails: string[] = [];

async function freshOrg(label: string) {
  const org = await prisma.organization.create({ data: { name: `OB ${label} ${stamp}`, slug: `ob-${label}-${stamp}` } });
  orgIds.push(org.id);
  return org.id;
}

function stageEvent(orgId: string | null, relationId: string, from: string, to: string) {
  return {
    name: 'pipeline.stage_change' as const,
    payload: { relationId, from, to },
    orgId,
    actor: { id: null, type: 'system' as const },
  };
}

const deliveries = (eventIds: string[]) =>
  prisma.job.findMany({
    where: { name: 'events.deliver', idempotencyKey: { in: eventIds.flatMap((id) => [deliveryKey(id, 'test.a'), deliveryKey(id, 'test.b')]) } },
    select: { idempotencyKey: true, runAt: true, orgId: true },
  });

test.beforeAll(() => {
  clearSubscriberRegistry();
  registerSubscriberEvents({ name: 'test.a', events: ['pipeline.stage_change'] });
  registerSubscriberEvents({ name: 'test.b', events: '*' });
});

test.afterAll(async () => {
  clearSubscriberRegistry();
  delete process.env.MT_ENFORCE_ISOLATION;
  const events = await prisma.domainEvent.findMany({ where: { orgId: { in: orgIds } }, select: { id: true } });
  await prisma.job.deleteMany({
    where: { name: 'events.deliver', idempotencyKey: { in: events.flatMap((e) => [deliveryKey(e.id, 'test.a'), deliveryKey(e.id, 'test.b')]) } },
  });
  await prisma.domainEvent.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } });
  for (const e of emails) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test.describe('the transactional outbox', { tag: '@smoke' }, () => {
  test('an event published in a rolled-back transaction leaves no row, and neither does its write', async () => {
    const orgId = await freshOrg('rollback');
    const relationId = `rb-${stamp}`;
    await expect(
      appPrisma.$transaction(async (tx) => {
        await publishEvent(tx, stageEvent(orgId, relationId, 'A', 'B'));
        throw new Error('the caller changed its mind');
      }),
    ).rejects.toThrow('the caller changed its mind');
    expect(await prisma.domainEvent.count({ where: { orgId, subjectId: relationId } })).toBe(0);

    // A payload off the published shape rolls the caller's own write back.
    await expect(
      appPrisma.$transaction(async (tx) => {
        await tx.organization.update({ where: { id: orgId }, data: { name: `OB renamed ${stamp}` } });
        await publishEvent(tx, { ...stageEvent(orgId, relationId, 'A', 'B'), payload: { relationId, from: 'A' } });
      }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).name).toBe(`OB rollback ${stamp}`);

    // The root client is refused at runtime too (the type refuses it already).
    await expect(
      publishEvent(appPrisma as never, stageEvent(orgId, relationId, 'A', 'B')),
    ).rejects.toThrow(/transaction client/);
  });

  test('the relay turns a row into one job per subscriber and marks it RELAYED exactly once, even when retried', async () => {
    const orgId = await freshOrg('relay');
    const ev = await appPrisma.$transaction((tx) => publishEvent(tx, stageEvent(orgId, `rl-${stamp}`, 'A', 'B')));

    await relayOnce();
    const row = await prisma.domainEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.status).toBe('RELAYED');
    expect(row.attempts).toBe(1);
    expect((await deliveries([ev.id])).map((j) => j.idempotencyKey).sort()).toEqual(
      [deliveryKey(ev.id, 'test.a'), deliveryKey(ev.id, 'test.b')].sort(),
    );

    // A relay that enqueued and then died before its mark committed comes back
    // to a PENDING row: the second pass may not enqueue a second delivery.
    await prisma.domainEvent.update({ where: { id: ev.id }, data: { status: 'PENDING' } });
    await relayOnce();
    await relayOnce();
    expect(await deliveries([ev.id])).toHaveLength(2);
    expect((await prisma.domainEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('RELAYED');
  });

  test('two events of one subject are relayed in createdAt order, never past a held older one', async () => {
    const orgId = await freshOrg('order');
    const relationId = `or-${stamp}`;
    // One transaction, two steps — the two-stage move that ties on the clock
    // without publish's monotonic stamp.
    const [first, second] = await appPrisma.$transaction(async (tx) => [
      await publishEvent(tx, stageEvent(orgId, relationId, 'A', 'B')),
      await publishEvent(tx, stageEvent(orgId, relationId, 'B', 'C')),
    ]);

    // Another relay holds the older row: this pass must defer the newer one.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM `DomainEvent` WHERE id = ? FOR UPDATE', first.id);
        locked();
        await held;
      },
      { timeout: 30_000 },
    );
    await isLocked;
    const pass = await relayOnce();
    expect(pass.deferred).toBeGreaterThanOrEqual(1);
    expect((await prisma.domainEvent.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('PENDING');
    release();
    await holder;

    await relayOnce();
    const rows = await prisma.domainEvent.findMany({ where: { id: { in: [first.id, second.id] } } });
    expect(rows.every((r) => r.status === 'RELAYED')).toBe(true);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(first.id)!.createdAt.getTime()).toBeLessThan(byId.get(second.id)!.createdAt.getTime());
    expect(byId.get(first.id)!.relayedAt!.getTime()).toBeLessThanOrEqual(byId.get(second.id)!.relayedAt!.getTime());
    // Deliveries leave in the same order: the queue claims by runAt.
    const jobs = await deliveries([first.id, second.id]);
    const runAt = (id: string) => jobs.find((j) => j.idempotencyKey === deliveryKey(id, 'test.a'))!.runAt.getTime();
    expect(runAt(first.id)).toBeLessThan(runAt(second.id));
  });

  test('with MT_ENFORCE_ISOLATION on, a relay kicked inside one tenant still relays every tenant', async () => {
    const orgA = await freshOrg('iso-a');
    const orgB = await freshOrg('iso-b');
    // Written through the helper client, outside any context, as another
    // request in another tenant would have.
    const [a, b] = await Promise.all(
      ([[orgA, `ia-${stamp}`], [orgB, `ib-${stamp}`]] as const).map(([orgId, rel]) =>
        prisma.domainEvent.create({ data: domainEventData(stageEvent(orgId, rel, 'A', 'B')) }),
      ),
    );

    process.env.MT_ENFORCE_ISOLATION = 'true';
    try {
      // The in-process kick runs inside the publishing request's context.
      await runWithOrg(orgA, () => relayOnce());
    } finally {
      delete process.env.MT_ENFORCE_ISOLATION;
    }
    const rows = await prisma.domainEvent.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.map((r) => r.status)).toEqual(['RELAYED', 'RELAYED']);
    const jobs = await deliveries([a.id, b.id]);
    expect(jobs).toHaveLength(4);
    // Each delivery carries its event's tenant.
    expect(jobs.filter((j) => j.orgId === orgB)).toHaveLength(2);
  });

  test('an array transaction carries publishEventOp atomically', async () => {
    const orgId = await freshOrg('array');
    const relationId = `ar-${stamp}`;
    await expect(
      appPrisma.$transaction([
        publishEventOp(stageEvent(orgId, relationId, 'A', 'B')),
        // A write that fails (unknown org id on a required FK) aborts the batch.
        appPrisma.mentorshipRelation.create({ data: { mentorId: 'missing', menteeId: 'missing', orgId } }),
      ]),
    ).rejects.toThrow();
    expect(await prisma.domainEvent.count({ where: { orgId, subjectId: relationId } })).toBe(0);
  });
});

test('a stage move over the API writes its event with the move; a refused move writes none', { tag: '@smoke' }, async ({ request }) => {
  const orgId = null;
  const mentor = await seedUser(uniqueEmail('ob-mentor'), 'Pass1234!', 'MENTOR', 'OB Mentor');
  const mentee = await seedUser(uniqueEmail('ob-mentee'), 'Pass1234!', 'MENTEE', 'OB Mentee');
  emails.push(mentor.email, mentee.email);
  const moved = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' },
  });
  const login = await signInViaApi(request, ADMIN_EMAIL, ADMIN_PASSWORD);
  expect(login.ok, login.error ?? '').toBe(true);

  try {
    const ok = await request.put(`/api/mentorship/${moved.id}`, { data: { pipelineStatus: 'APPROVAL_PENDING_220' } });
    expect(ok.status()).toBe(200);
    const events = await prisma.domainEvent.findMany({ where: { name: 'pipeline.stage_change', subjectId: moved.id } });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ relationId: moved.id, from: 'APPLICATION_100', to: 'APPROVAL_PENDING_220' });
    expect(events[0].actorType).toBe('user');
    expect(events[0].status).toBe('PENDING');

    // Refused inside the transaction (#419: the mentee is already actively
    // mentored elsewhere): neither the move nor its event may survive.
    await prisma.mentorshipRelation.update({ where: { id: moved.id }, data: { status: 'COMPLETED' } });
    const other = await prisma.mentorshipRelation.create({
      data: { orgId, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100', status: 'ACTIVE' },
    });
    const refused = await request.put(`/api/mentorship/${moved.id}`, {
      data: { status: 'ACTIVE', pipelineStatus: 'INTERVIEW_PENDING_250' },
    });
    expect(refused.status()).toBe(409);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: moved.id } })).pipelineStatus).toBe('APPROVAL_PENDING_220');
    expect(await prisma.domainEvent.count({ where: { name: 'pipeline.stage_change', subjectId: moved.id } })).toBe(1);
    await prisma.mentorshipRelation.delete({ where: { id: other.id } });
  } finally {
    await prisma.domainEvent.deleteMany({ where: { subjectId: moved.id } });
    await prisma.statusChange.deleteMany({ where: { relationId: moved.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
  }
});
