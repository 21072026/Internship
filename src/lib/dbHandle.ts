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
// Nested, the unit JOINS the caller's transaction — with no savepoint (#2988).
// MySQL has no nested transactions, and it refuses SAVEPOINT / ROLLBACK TO
// SAVEPOINT over the prepared-statement protocol (error 1295), which is how
// Prisma 5 sends every raw query; MariaDB accepts them, which is why a
// savepoint version passed locally and failed on MySQL 8 in CI. So a unit that
// throws partway leaves the writes it made before the throw in the caller's
// transaction, and nothing here can take them back. Two rules follow:
//   • A unit that refuses ON PURPOSE decides before its first write and
//     answers the refusal instead of throwing it out of the unit (winBack() is
//     the worked example), so a refusal leaves nothing behind.
//   • Anything else that throws marks the transaction (`unitFailedIn`). The
//     owner of a transaction it handed to writers checks that before it trusts
//     what the transaction holds — the batch dry run stops there and answers
//     `dry_run_inconclusive` rather than outcomes the real run would not give.
//
// SERVER-ONLY (Prisma).

export type Db = typeof prisma | Prisma.TransactionClient;

/** Caller transactions in which a joined unit threw (its earlier writes are still there). */
const failedUnits = new WeakSet<object>();

/** Run `fn` in a transaction: a new one on the root client, the caller's own otherwise. */
export async function inTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (db === prisma) return prisma.$transaction(fn);
  const tx = db as Prisma.TransactionClient;
  try {
    return await fn(tx);
  } catch (e) {
    failedUnits.add(tx);
    throw e;
  }
}

/** Whether a unit joined to this caller transaction threw, leaving part of its writes behind. */
export function unitFailedIn(db: Db): boolean {
  return db !== prisma && failedUnits.has(db);
}
