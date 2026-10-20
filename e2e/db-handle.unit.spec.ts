// Unit tests for the database handle a writer runs against (src/lib/dbHandle.ts,
// #2966/#2988) — pure node, no browser, no database. Playwright resolves the
// tsconfig `@/` paths, which `node --test` cannot; run with
// BASE_URL=http://localhost:9 to skip the webServer.
//
// WHAT IS PROVED HERE: a unit joined to a caller's transaction runs on that
// transaction and sends NO savepoint statement — MySQL refuses SAVEPOINT over
// the prepared-statement protocol Prisma 5 uses for every raw query (error
// 1295), which is what turned the batch dry run red on MySQL 8 while MariaDB
// passed — and a unit that throws marks the caller's transaction, so its owner
// can tell that writes made before the throw are still in it.
//
// WHAT IS NOT: the root-client path (a real `prisma.$transaction`) needs a
// database; e2e/account-events-lost-batch.spec.ts drives both paths end to end.
import { test, expect } from '@playwright/test';
import type { Prisma } from '@prisma/client';
import { inTransaction, unitFailedIn } from '@/lib/dbHandle';
import { prisma } from '@/lib/prisma';

/** A stand-in for an interactive transaction client that records every raw statement. */
function fakeTx() {
  const raw: string[] = [];
  const record = async (sql: unknown) => {
    raw.push(String(sql));
    return 0;
  };
  const tx = { $executeRawUnsafe: record, $queryRawUnsafe: record, $executeRaw: record, $queryRaw: record };
  return { tx: tx as unknown as Prisma.TransactionClient, raw };
}

test('a joined unit runs on the caller\'s transaction and sends no savepoint', { tag: '@smoke' }, async () => {
  const { tx, raw } = fakeTx();
  const seen = await inTransaction(tx, async (inner) => inner);
  expect(seen).toBe(tx);
  const nested = await inTransaction(tx, (outer) => inTransaction(outer, async () => 'done'));
  expect(nested).toBe('done');
  expect(raw).toEqual([]);
  expect(unitFailedIn(tx)).toBe(false);
});

test('a joined unit that throws marks the caller\'s transaction; the error travels on', { tag: '@smoke' }, async () => {
  const { tx, raw } = fakeTx();
  const boom = new Error('write failed partway');
  await expect(inTransaction(tx, async () => { throw boom; })).rejects.toBe(boom);
  expect(unitFailedIn(tx)).toBe(true);
  expect(raw).toEqual([]);

  // Another caller's transaction is not affected, and the root client never is.
  expect(unitFailedIn(fakeTx().tx)).toBe(false);
  expect(unitFailedIn(prisma)).toBe(false);
});
