// The outbox relay (#1680): committed DomainEvent rows → one queue job per
// subscriber.
//
// SHAPE. The mail drain's (src/lib/mailOutbox.ts): ticked on EVERY replica,
// rows claimed with `FOR UPDATE SKIP LOCKED`, NO lease. Two relays take
// disjoint rows, so more replicas only relay faster; a lease here would be the
// second election mechanism CLAUDE.md forbids, and one replica's death would
// stop every event.
//
// ONE ROW, ONE TRANSACTION. Each event is claimed, fanned out and marked in
// its own short transaction:
//   1. SELECT the oldest PENDING row … FOR UPDATE SKIP LOCKED
//   2. per-subject order: if an OLDER PENDING row of the same subject exists
//      (another relay holds it, or it failed this tick), leave this one for
//      later — two stage changes of one relation are never relayed out of
//      order;
//   3. INSERT one `events.deliver` job per subscriber, keyed
//      `${eventId}:${subscriber}` (`Job.idempotencyKey` is unique, the insert
//      skips duplicates) — a relay retried after its jobs committed cannot
//      enqueue a second delivery;
//   4. mark the row RELAYED, guarded on `status = 'PENDING'`.
// Steps 3 and 4 commit together, so an event is relayed exactly once even
// when a relay pass dies half-way: either nothing of it committed and the row
// is PENDING again, or all of it did. A row that keeps failing does not poison
// its neighbours: its attempts are counted outside the rolled-back
// transaction and it goes FAILED after OUTBOX_MAX_ATTEMPTS.
//
// NO SESSION. The relay crosses every tenant. `DomainEvent` is in
// TENANT_MODELS, so with MT_ENFORCE_ISOLATION on a relay that inherited a
// bound org — the in-process kick after a publish runs inside the publishing
// request's context — would see that one tenant's rows, and a relay with no
// context at all is correct only by accident. So it binds the explicit
// "no tenant" context (`runWithOrg(null, …)`) itself, and the claim is raw SQL
// that names its own conditions. e2e/outbox-relay.spec.ts proves it with the
// flag on.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { logger } from '@/lib/logger';
import { DELIVER_JOB_NAME, deliveryKey, subscribersFor } from './subscribers';

/** A row that failed this many relay attempts is parked as FAILED. */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** Events relayed per pass, at most. */
export const RELAY_BATCH = 100;

export interface RelaySummary {
  relayed: number;
  deliveries: number;
  /** Waiting behind an older event of the same subject. */
  deferred: number;
  failed: number;
}

interface ClaimedRow {
  id: string;
  orgId: string | null;
  name: string;
  subjectType: string | null;
  subjectId: string | null;
  createdAt: Date;
}

type Step =
  | { kind: 'empty' }
  | { kind: 'deferred'; id: string }
  | { kind: 'relayed'; id: string; deliveries: number }
  | { kind: 'failed'; id: string };

async function relayNext(skip: string[], now: Date): Promise<Step> {
  let claimedId: string | null = null;
  try {
    return await prisma.$transaction(async (tx) => {
      const notSkipped = skip.length ? Prisma.sql`AND id NOT IN (${Prisma.join(skip)})` : Prisma.empty;
      const rows = await tx.$queryRaw<ClaimedRow[]>(Prisma.sql`
        SELECT id, orgId, name, subjectType, subjectId, createdAt
          FROM \`DomainEvent\`
         WHERE status = 'PENDING'
           ${notSkipped}
         ORDER BY createdAt ASC, id ASC
         LIMIT 1
           FOR UPDATE SKIP LOCKED
      `);
      const ev = rows[0];
      if (!ev) return { kind: 'empty' } as const;
      claimedId = ev.id;

      if (ev.subjectId) {
        // A consistent (non-locking) read: it sees an older row another relay
        // has locked as still PENDING, which is exactly when we must wait.
        const older = await tx.$queryRaw<{ n: bigint | number }[]>(Prisma.sql`
          SELECT COUNT(*) AS n
            FROM \`DomainEvent\`
           WHERE status = 'PENDING'
             AND subjectType <=> ${ev.subjectType}
             AND subjectId = ${ev.subjectId}
             AND (createdAt < ${ev.createdAt} OR (createdAt = ${ev.createdAt} AND id < ${ev.id}))
        `);
        if (Number(older[0]?.n ?? 0) > 0) return { kind: 'deferred', id: ev.id } as const;
      }

      const subscribers = subscribersFor(ev.name);
      if (subscribers.length > 0) {
        await tx.job.createMany({
          data: subscribers.map((subscriber) => ({
            name: DELIVER_JOB_NAME,
            payload: { eventId: ev.id, subscriber },
            idempotencyKey: deliveryKey(ev.id, subscriber),
            orgId: ev.orgId,
            // The event's own time: the queue claims by runAt, so deliveries
            // of one subject leave in the order their events happened.
            runAt: ev.createdAt,
          })),
          skipDuplicates: true,
        });
      }
      await tx.domainEvent.updateMany({
        where: { id: ev.id, status: 'PENDING' },
        data: { status: 'RELAYED', relayedAt: now, attempts: { increment: 1 } },
      });
      return { kind: 'relayed', id: ev.id, deliveries: subscribers.length } as const;
    });
  } catch (e) {
    if (!claimedId) throw e;
    // The transaction rolled back; count the attempt outside it.
    const id: string = claimedId;
    logger.warning('domain_event.relay_failed', { eventId: id, error: e instanceof Error ? e.name : 'unknown' });
    await prisma.domainEvent.updateMany({ where: { id, status: 'PENDING' }, data: { attempts: { increment: 1 } } });
    await prisma.domainEvent.updateMany({
      where: { id, status: 'PENDING', attempts: { gte: OUTBOX_MAX_ATTEMPTS } },
      data: { status: 'FAILED' },
    });
    return { kind: 'failed', id };
  }
}

/** One relay pass: up to `limit` events, oldest first. */
export async function relayOnce(opts: { limit?: number; now?: () => Date } = {}): Promise<RelaySummary> {
  const limit = Math.min(RELAY_BATCH, Math.max(1, Math.trunc(opts.limit ?? RELAY_BATCH)));
  const clock = opts.now ?? (() => new Date());
  return runWithOrg(null, async () => {
    const summary: RelaySummary = { relayed: 0, deliveries: 0, deferred: 0, failed: 0 };
    const skip: string[] = [];
    for (let i = 0; i < limit; i++) {
      const step = await relayNext(skip, clock());
      if (step.kind === 'empty') break;
      if (step.kind === 'relayed') {
        summary.relayed++;
        summary.deliveries += step.deliveries;
      } else {
        skip.push(step.id);
        if (step.kind === 'deferred') summary.deferred++;
        else summary.failed++;
      }
    }
    return summary;
  });
}
