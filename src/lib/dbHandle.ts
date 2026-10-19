import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// The database handle a writer runs against (#2966): the root client, or an
// interactive transaction a caller already opened.
//
// Why a writer takes one at all: the account-event batch's dry run
// (docs/integrations/account-events.md § Dry run) is the SAME ingest call run
// inside one transaction that is rolled back at the end — a writer that does
// not write, without a second copy of the logic. Every write and every read
// that must see the run's own earlier writes therefore goes through the handle
// it was given, and a writer that needs its own transaction asks
// `inTransaction` instead of `prisma.$transaction`.
//
// Nested, it keeps the all-or-nothing promise with a SAVEPOINT: MySQL has no
// nested transactions, so the inner unit joins the caller's transaction, and a
// failure inside it rolls back to the savepoint before the error travels on —
// exactly what the unit's own transaction would have left behind (nothing),
// while the caller's transaction stays usable.
//
// SERVER-ONLY (Prisma).

export type Db = typeof prisma | Prisma.TransactionClient;

let savepoints = 0;

/** Run `fn` in a transaction: a new one on the root client, a savepoint inside the caller's otherwise. */
export async function inTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (db === prisma) return prisma.$transaction(fn);
  const tx = db as Prisma.TransactionClient;
  // A name of our own making (never input): letters, digits and `_` only.
  const name = `sp_unit_${(savepoints = (savepoints + 1) % 1_000_000)}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const result = await fn(tx);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (e) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    throw e;
  }
}
