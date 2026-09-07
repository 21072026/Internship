import { test, expect } from '@playwright/test';
import {
  DEFAULT_RETENTION_BATCH_SIZE,
  clearRetentionRegistry,
  formatRetentionSummary,
  listRetentionEntries,
  pruneInBatches,
  registerRetention,
  runRetention,
  type RetentionEntry,
} from '@/lib/retentionPrune';

// The retention MECHANISM (#1678), tested without a database.
//
// Four properties are load-bearing and none of them is visible from the
// database-backed spec next door, because each one is about what happens when
// something goes wrong or when a fifth table arrives:
//
//   1. A fifth table is ONE `registerRetention()` call and NO new schedule —
//      the thing four other issues (#1585, #1646, #1691, #2056) are waiting on.
//   2. An entry can MASK instead of delete. #2056 rewrites `deletedForEveryoneAt`
//      and #1646 must skip unread rows; a registry that could only take a
//      `{ table, dateField }` descriptor would have to be redesigned for them.
//   3. One entry throwing does not stop the others, and the failure is recorded.
//      A retention job that stops at the first error stops pruning four other
//      tables silently, and the symptom is rows quietly not disappearing.
//   4. Deletion is BATCHED and capped. A single unbounded DELETE against a table
//      that has grown for a year locks it for the length of the statement.

function entry(over: Partial<RetentionEntry> & Pick<RetentionEntry, 'key' | 'run'>): RetentionEntry {
  return { defaultDays: 30, reason: 'test fixture', ...over };
}

test.beforeEach(() => clearRetentionRegistry());
test.afterAll(() => clearRetentionRegistry());

test('a new table is one registerRetention call, and the runner picks it up', async () => {
  const seen: string[] = [];
  registerRetention(entry({ key: 'fakeTable', defaultDays: 10, run: async (ctx) => { seen.push(ctx.cutoff.toISOString()); return { deleted: 7 }; } }));

  expect(listRetentionEntries().map((e) => e.key)).toEqual(['fakeTable']);

  const now = new Date('2026-09-07T03:20:00.000Z');
  const result = await runRetention({ now });

  expect(result.deleted).toBe(7);
  expect(result.failed).toEqual([]);
  // The window is applied by the runner, from one clock, so every entry in a
  // run measures against the same instant.
  expect(seen).toEqual(['2026-08-28T03:20:00.000Z']);
});

test('registering the same key twice replaces rather than duplicates', async () => {
  registerRetention(entry({ key: 'dupe', run: async () => ({ deleted: 1 }) }));
  registerRetention(entry({ key: 'dupe', run: async () => ({ deleted: 5 }) }));

  expect(listRetentionEntries()).toHaveLength(1);
  expect((await runRetention()).deleted).toBe(5);
});

test('an entry may mask rows instead of deleting them (#2056)', async () => {
  let maskedRows = 0;
  registerRetention(
    entry({
      key: 'message',
      run: async () => {
        maskedRows = 4; // e.g. stamping deletedForEveryoneAt
        return { deleted: 0, masked: maskedRows, note: 'masked, not deleted' };
      },
    })
  );

  const result = await runRetention();
  expect(result.deleted).toBe(0);
  expect(result.masked).toBe(4);
  expect(result.results[0].note).toBe('masked, not deleted');
  expect(maskedRows).toBe(4);
  // And the summary line distinguishes the two, so an operator reading the
  // audit row cannot mistake a mask for a delete.
  expect(formatRetentionSummary(result)).toContain('message=0/4m');
});

test('one entry throwing does not abort the run, and the failure is recorded', async () => {
  const ran: string[] = [];
  registerRetention(entry({ key: 'first', run: async () => { ran.push('first'); return { deleted: 2 }; } }));
  registerRetention(entry({ key: 'broken', run: async () => { ran.push('broken'); throw new Error('table is gone'); } }));
  registerRetention(entry({ key: 'third', run: async () => { ran.push('third'); return { deleted: 3 }; } }));

  const result = await runRetention();

  expect(ran).toEqual(['first', 'broken', 'third']);
  expect(result.failed).toEqual(['broken']);
  expect(result.deleted).toBe(5);
  expect(result.results.find((r) => r.key === 'broken')?.error).toBe('table is gone');
  // The audit line has to carry the failure too — the ActivityLog row is where
  // somebody looks a week later.
  expect(formatRetentionSummary(result)).toContain('broken=ERR');
});

test('an unusable configured window falls back to the default instead of deleting everything', async () => {
  const cutoffs: Record<string, Date> = {};
  registerRetention(entry({ key: 'zero', defaultDays: 90, run: async (ctx) => { cutoffs.zero = ctx.cutoff; return { deleted: 0 }; } }));
  registerRetention(entry({ key: 'nan', defaultDays: 60, run: async (ctx) => { cutoffs.nan = ctx.cutoff; return { deleted: 0 }; } }));
  registerRetention(entry({ key: 'set', defaultDays: 60, run: async (ctx) => { cutoffs.set = ctx.cutoff; return { deleted: 0 }; } }));

  const now = new Date('2026-09-07T00:00:00.000Z');
  await runRetention({
    now,
    // 0 would put the cutoff at "now" and empty the table; NaN is a corrupted
    // settings row. Both must be ignored.
    resolveDays: (e) => ({ zero: 0, nan: Number.NaN, set: 5 })[e.key] ?? null,
  });

  expect(cutoffs.zero.toISOString()).toBe('2026-06-09T00:00:00.000Z'); // 90 default
  expect(cutoffs.nan.toISOString()).toBe('2026-07-09T00:00:00.000Z'); // 60 default
  expect(cutoffs.set.toISOString()).toBe('2026-09-02T00:00:00.000Z'); // 5 configured
});

test('pruneInBatches deletes in bounded statements and stops when the table is clean', async () => {
  const batches: number[] = [];
  let remaining = 1_250;

  const { processed, capped } = await pruneInBatches({
    batchSize: 500,
    budget: 10_000,
    selectIds: async (take) => Array.from({ length: Math.min(take, remaining) }, (_, i) => `id-${i}`),
    handleBatch: async (ids) => {
      batches.push(ids.length);
      remaining -= ids.length;
      return ids.length;
    },
  });

  expect(batches).toEqual([500, 500, 250]);
  expect(processed).toBe(1_250);
  expect(capped).toBe(false);
});

test('pruneInBatches respects the per-run cap and says it is still catching up', async () => {
  const batches: number[] = [];
  const { processed, capped } = await pruneInBatches({
    batchSize: 500,
    budget: 1_200,
    // An inexhaustible backlog: the first run after a year of growth.
    selectIds: async (take) => Array.from({ length: take }, (_, i) => `id-${i}`),
    handleBatch: async (ids) => { batches.push(ids.length); return ids.length; },
  });

  expect(batches).toEqual([500, 500, 200]);
  expect(processed).toBe(1_200);
  // `capped` is what tells an operator the table is draining over several runs
  // rather than that it is clean.
  expect(capped).toBe(true);
});

test('pruneInBatches cannot loop forever when a batch deletes nothing', async () => {
  let calls = 0;
  const { processed } = await pruneInBatches({
    batchSize: 10,
    budget: 1_000,
    selectIds: async () => { calls += 1; return ['stuck-1', 'stuck-2']; },
    handleBatch: async () => 0, // rows vanished under us, or the filter is wrong
  });

  expect(calls).toBe(1);
  expect(processed).toBe(0);
});

test('the summary line always fits ActivityLog.detail', () => {
  for (let i = 0; i < 40; i += 1) {
    registerRetention(entry({ key: `table-with-a-long-name-${i}`, run: async () => ({ deleted: 12_345 }) }));
  }
  const results = listRetentionEntries().map((e) => ({
    key: e.key,
    retentionDays: 30,
    cutoff: new Date(),
    deleted: 12_345,
    masked: 0,
    capped: false,
  }));

  const line = formatRetentionSummary({ startedAt: new Date(), durationMs: 1_234, results, deleted: 0, masked: 0, failed: [] });
  // VARCHAR(191): an oversized detail throws P2000 and loses the whole row (#1268).
  expect(line.length).toBeLessThanOrEqual(191);
  expect(line.endsWith('…')).toBe(true);
});

test('a run with nothing to do still says so', () => {
  const line = formatRetentionSummary({ startedAt: new Date(), durationMs: 40, results: [], deleted: 0, masked: 0, failed: [] });
  expect(line).toBe('nothing to prune (0s)');
  expect(DEFAULT_RETENTION_BATCH_SIZE).toBe(500);
});
