import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { setQueueLogger, type JobRecord, type QueueStore } from './queue';

// The Prisma half of the queue engine (#1671): the seven row operations
// `./queue` needs, and nothing else.
//
// Split out for the same reason `leaseStore.ts` is split out of `lease.ts` —
// the rules stay unit-testable and importing the rules module never constructs
// a Prisma client. The SAFETY ARGUMENT for everything below is in `./queue`'s
// header; what matters HERE is that each operation is the statement shape that
// argument assumes.
//
// REQUIRES MySQL 8.0.1+ for `SKIP LOCKED`. The server runs 8.0.46 and CI runs
// the `mysql:8.0` image; see the header of `./queue` for the full note and for
// why an older engine fails loudly rather than silently serialising.
//
// TENANT SCOPE. The raw SELECT below bypasses the isolation middleware
// (`src/lib/orgContext.ts`) the way every `$queryRaw` does, and the Prisma calls
// around it are unscoped in practice because a worker runs outside any request
// and therefore has no bound org — the middleware's own rule is "no bound
// context → do not scope". That is deliberate and matches the other operational
// readers (`health.ts`, `dlqAlert.ts`): a queue worker has to drain every
// tenant's work, and a claim query that could only see one org would leave the
// rest of the queue unclaimed forever. Per-tenant queue VIEWS are a different
// thing and belong to the operations console (#1607), which reads through the
// ordinary scoped client.

// Give the rules module the app's real logger; it defaults to console.
setQueueLogger(logger);

// Prisma's generated `Job` row is structurally a `JobRecord`; this names the
// conversion in one place instead of at four call sites.
type PrismaJob = Awaited<ReturnType<typeof prisma.job.findFirstOrThrow>>;
const toRecord = (row: PrismaJob): JobRecord => row as JobRecord;

export function prismaQueueStore(): QueueStore {
  return {
    insertJob: async (data) => {
      const row = await prisma.job.create({
        data: {
          name: data.name,
          // `payload` is a MySQL JSON column; Prisma types it as InputJsonValue
          // and the union in `./queue` is deliberately `unknown` so the rules
          // module carries no Prisma types.
          payload: data.payload as Prisma.InputJsonValue,
          runAt: data.runAt,
          priority: data.priority,
          maxAttempts: data.maxAttempts,
          idempotencyKey: data.idempotencyKey,
          orgId: data.orgId,
        },
      });
      return toRecord(row);
    },

    findJobByIdempotencyKey: async (key) => {
      const row = await prisma.job.findUnique({ where: { idempotencyKey: key } });
      return row ? toRecord(row) : null;
    },

    claimDue: async ({ now, limit, workerId }) => {
      // Re-clamped here rather than trusted from the caller: this value is
      // interpolated into the SQL text (see below) and an integer is the only
      // thing that may ever be.
      const take = Math.min(100, Math.max(1, Math.trunc(limit)));
      // VarChar(64) — a truncated worker id could collide with another
      // worker's, so it is cut here where the column width is known.
      const holder = workerId.slice(0, 64);

      return prisma.$transaction(async (tx) => {
        // ── The claim. The whole engine rests on this statement. ───────────
        //
        // `FOR UPDATE` write-locks every row the SELECT returns, for the life
        // of this transaction. `SKIP LOCKED` makes a concurrent transaction
        // step OVER rows this one has locked rather than block on them, so two
        // workers running this at the same instant get disjoint id sets.
        //
        // `LIMIT` is interpolated with `Prisma.raw` rather than bound: MySQL
        // accepts a placeholder there, but only for a prepared integer, and an
        // integer we produced two lines above with `Math.trunc` on a clamped
        // range is not user input by any path. Every other value IS bound.
        //
        // `Job` is backticked — table names are not quoted by Prisma in raw
        // SQL and the schema has no `@@map`, so the table is literally `Job`.
        const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT id
            FROM \`Job\`
           WHERE status = 'PENDING'
             AND runAt <= ${now}
           ORDER BY priority DESC, runAt ASC
           LIMIT ${Prisma.raw(String(take))}
             FOR UPDATE SKIP LOCKED
        `);

        const ids = rows.map((row) => row.id);
        if (ids.length === 0) return [];

        // Still inside the transaction, over exactly the locked ids, so this
        // update is uncontended. `status: 'PENDING'` is re-asserted as belt and
        // braces for a row changed by some path that is not this query (an
        // admin cancelling a job, a future bulk requeue) and costs nothing.
        //
        // `attempts` is NOT incremented — that is the worker's bookkeeping
        // (#1673); see `claim()` in `./queue`.
        await tx.job.updateMany({
          where: { id: { in: ids }, status: 'PENDING' },
          data: { status: 'RUNNING', lockedAt: now, lockedBy: holder },
        });

        // Re-read rather than returning the raw SELECT's columns: `payload` is
        // a JSON column and `$queryRaw` hands JSON back as a driver-shaped
        // value (a string on some paths), while the typed client parses it.
        // The worker gets the payload it was promised, not something it has to
        // guess at. Still inside the transaction, so it sees this update.
        const claimed = await tx.job.findMany({
          where: { id: { in: ids }, lockedBy: holder, status: 'RUNNING' },
          orderBy: [{ priority: 'desc' }, { runAt: 'asc' }],
        });
        return claimed.map(toRecord);
      });
    },

    reapExpired: async ({ lockedBefore }) => {
      // ONE conditional UPDATE, so two replicas reaping at the same moment
      // cannot both "win" a row — the same shape as `lease.ts`'s rule 2.
      // A RUNNING row with a null `lockedAt` is deliberately NOT matched: the
      // claim sets status and lock in one statement, so the pair cannot come
      // apart, and a sweep that reset RUNNING rows with no timestamp would
      // requeue work the moment anything else ever sets RUNNING by hand.
      const { count } = await prisma.job.updateMany({
        where: { status: 'RUNNING', lockedAt: { lt: lockedBefore } },
        // `attempts` intentionally absent — a lease that expired is not an
        // attempt that failed. See `reapExpiredLeases()` in `./queue`.
        data: { status: 'PENDING', lockedAt: null, lockedBy: null },
      });
      return count;
    },

    insertRun: async (row) => {
      const created = await prisma.jobRun.create({
        data: {
          jobId: row.jobId,
          attempt: row.attempt,
          trigger: row.trigger,
          startedAt: row.startedAt,
        },
        select: { id: true },
      });
      return created.id;
    },

    finishRun: async (runId, patch) => {
      await prisma.jobRun.update({
        where: { id: runId },
        data: {
          finishedAt: patch.finishedAt,
          durationMs: patch.durationMs,
          ok: patch.ok,
          error: patch.error,
          // `Prisma.DbNull` rather than `null`: on a nullable JSON column a
          // plain `null` is ambiguous (JSON null vs SQL NULL) and Prisma
          // refuses it at runtime.
          summary: patch.summary === null ? Prisma.DbNull : (patch.summary as Prisma.InputJsonValue),
        },
      });
    },

    deleteRunsStartedBefore: async (cutoff) => {
      const { count } = await prisma.jobRun.deleteMany({ where: { startedAt: { lt: cutoff } } });
      return count;
    },
  };
}
