import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { setLeaseLogger, type LeaseRow, type LeaseStore } from './lease';

// The `JobLease` half of #1701: the three row operations `src/lib/jobs/lease.ts`
// needs, and nothing else. Split out for one reason — `lease.ts` holds the
// rules and is loaded by `node --test --experimental-strip-types`, which cannot
// resolve the `@/` alias. Everything Prisma-shaped lives here instead, exactly
// as `rateLimitStore.ts` keeps its socket client in `rateLimitRedis.ts`.
//
// The safety argument is in `lease.ts`; what matters HERE is that each write is
// ONE statement. `updateMany` with a `where` compiles to a single
// `UPDATE JobLease SET … WHERE name = ? AND …` and reports how many rows it
// changed, which is the conditional update the rules are built on. Prisma's
// `update()` would not do: it throws when the row does not match, and — worse —
// `findFirst` + `update` would be the read-then-write that lets two replicas
// both believe they won.

// Give the rules module the app's real logger; it defaults to console.
setLeaseLogger(logger);

export function prismaLeaseStore(): LeaseStore {
  return {
    read: async (name) => {
      const row = await prisma.jobLease.findUnique({ where: { name } });
      return row ?? null;
    },

    insert: async (row: LeaseRow) => {
      try {
        await prisma.jobLease.create({ data: row });
        return true;
      } catch {
        // The only expected failure is the primary key: another replica
        // inserted the first row for this lease a moment ago. That is the
        // mechanism working, not an error — the caller reads `false` as "not
        // mine" and stays quiet. A genuine database outage also lands here and
        // is reported by the caller's own catch, which treats it the same way:
        // not the holder, do nothing.
        return false;
      }
    },

    update: async (name, cond, next) => {
      const { bumpGeneration, ...set } = next;
      // Collected into `AND` rather than spread flat: two clauses on the same
      // column (`expiresAt > x` and `expiresAt <= y`) would collide as object
      // keys and one of them would vanish — a precondition that silently
      // disappears is the one bug this whole module exists to prevent.
      const clauses = [
        ...(cond.holder !== undefined ? [{ holder: cond.holder }] : []),
        // `expiresAt > now` — the lease is still live.
        ...(cond.notExpiredAt !== undefined ? [{ expiresAt: { gt: cond.notExpiredAt } }] : []),
        // `expiresAt <= now` — the lease is stealable.
        ...(cond.expiredAt !== undefined ? [{ expiresAt: { lte: cond.expiredAt } }] : []),
      ];
      const { count } = await prisma.jobLease.updateMany({
        where: { name, AND: clauses },
        data: {
          ...set,
          ...(bumpGeneration ? { generation: { increment: 1 } } : {}),
        },
      });
      // `name` is the primary key, so this is 0 or 1 — never a partial write.
      return count === 1;
    },

    heldBy: async (holder, now) =>
      prisma.jobLease.findMany({ where: { holder, expiresAt: { gt: now } } }),
  };
}
