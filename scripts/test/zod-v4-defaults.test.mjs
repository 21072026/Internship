// zod 4 changed where `.default()` applies (#3558): a default now fills an
// absent key even inside `.optional()` / `.partial()`, where zod 3 left the
// key out. A PATCH schema derived with `.partial()` from a create schema that
// has defaults would therefore write those defaults on every partial update.
// These cases pin the zod 3 behaviour the routes were written against.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { requisitionInputSchema, requisitionPatchSchema } = await import('../../src/lib/requisitions.ts');

test('a requisition PATCH sets only the keys it sends — no defaulted status or filled', () => {
  const parsed = requisitionPatchSchema.parse({ title: 'Renamed role' });
  assert.deepEqual(parsed, { title: 'Renamed role' });
  assert.ok(!('status' in parsed) && !('filled' in parsed));
});

test('a requisition PATCH still validates the keys it does send', () => {
  assert.deepEqual(requisitionPatchSchema.parse({ status: 'OPEN', filled: 2 }), { status: 'OPEN', filled: 2 });
  assert.equal(requisitionPatchSchema.safeParse({ filled: -1 }).success, false);
  assert.equal(requisitionPatchSchema.safeParse({ companyId: 'x' }).success, false, 'companyId is not patchable');
  assert.equal(requisitionPatchSchema.safeParse({ unknownKey: 1 }).success, false, 'still strict');
});

test('creating a requisition still fills the defaults', () => {
  const parsed = requisitionInputSchema.parse({ title: 'Role', openings: 1, requiredSkills: [] });
  assert.equal(parsed.status, 'DRAFT');
  assert.equal(parsed.filled, 0);
});

// zod 4 made `z.record(z.enum([...]), v)` exhaustive: every enum key becomes
// required. zod 3's partial record is `z.partialRecord` in zod 4, which the
// three enum-keyed records (evaluation labels, migration rows, notification
// channels) use — a request that sets one category must keep parsing.
test('an enum-keyed partial record accepts a subset of the keys, as zod 3 did', async () => {
  const { z } = await import('zod');
  const keys = z.enum(['a', 'b', 'c']);
  assert.deepEqual(z.partialRecord(keys, z.string()).parse({ a: 'x' }), { a: 'x' });
  assert.equal(z.partialRecord(keys, z.string()).safeParse({ d: 'x' }).success, false, 'unknown keys still refused');
  assert.equal(z.record(keys, z.string()).safeParse({ a: 'x' }).success, false, 'the exhaustive form would refuse it');
});
