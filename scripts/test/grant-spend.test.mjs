// Unit tests for the single-use grant spend (#2548).
// Run: node --test --experimental-strip-types scripts/test/grant-spend.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendGrant } from '../../src/lib/grantSpend.ts';

// An in-memory table that behaves like the database on one row: it applies a
// `where` and the write in one step, and yields between callers the way
// concurrent requests interleave on a real connection pool.
function table(row) {
  const calls = [];
  const updateMany = async (where) => {
    calls.push(where);
    await new Promise((r) => setImmediate(r));
    const match =
      row.id === where.id &&
      (where.used === undefined || row.used === where.used) &&
      (where.expiresAt?.gt === undefined || row.expiresAt > where.expiresAt.gt);
    if (!match) return { count: 0 };
    row.used = true;
    return { count: 1 };
  };
  return { row, calls, updateMany };
}

const NOW = new Date('2026-09-29T12:00:00Z');
const LATER = new Date('2026-09-29T12:02:00Z');

test('the database, not JavaScript, checks that the grant is unused and unexpired', async () => {
  const t = table({ id: 'g1', used: false, expiresAt: LATER });
  assert.equal(await spendGrant(t.updateMany, 'g1', NOW), true);
  assert.deepEqual(t.calls[0], { id: 'g1', used: false, expiresAt: { gt: NOW } });
});

test('of many concurrent redemptions exactly one wins', async () => {
  const t = table({ id: 'g1', used: false, expiresAt: LATER });
  const results = await Promise.all(Array.from({ length: 8 }, () => spendGrant(t.updateMany, 'g1', NOW)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(t.row.used, true);
});

test('a spent grant stays spent', async () => {
  const t = table({ id: 'g1', used: true, expiresAt: LATER });
  assert.equal(await spendGrant(t.updateMany, 'g1', NOW), false);
});

test('an expired grant cannot be spent, and is not flipped', async () => {
  const t = table({ id: 'g1', used: false, expiresAt: NOW });
  assert.equal(await spendGrant(t.updateMany, 'g1', NOW), false);
  assert.equal(t.row.used, false);
});
