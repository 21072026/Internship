// `z.strictObject()` is the zod 4 spelling of `z.object().strict()` (#3568).
//
// The migration rewrote 201 schemas from the deprecated form and dropped one
// trailing `.strict()` that became redundant (program-costs' patch schema is
// `strictShape.partial().extend(...)`). Both moves rely on what these tests pin:
// the two forms refuse an unknown key with the same issue, and `.partial()` /
// `.extend()` keep the strictness of the object they start from. If a zod
// upgrade changes either, a request body with an extra key would start to pass.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const issues = (r) => r.error.issues.map(({ code, keys, path }) => ({ code, keys, path }));

test('strictObject refuses an unknown key exactly like object().strict()', () => {
  const shape = { name: z.string() };
  const body = { name: 'a', extra: 1 };
  const legacy = z.object(shape).strict().safeParse(body);
  const current = z.strictObject(shape).safeParse(body);
  assert.equal(legacy.success, false);
  assert.equal(current.success, false);
  assert.deepEqual(issues(current), issues(legacy));
  assert.equal(current.error.issues[0].message, legacy.error.issues[0].message);
});

test('partial() and extend() keep a strict object strict', () => {
  const base = z.strictObject({ amount: z.number() });
  assert.equal(base.partial().safeParse({ extra: 1 }).success, false);
  const patch = base.partial().extend({ id: z.string() });
  assert.equal(patch.safeParse({ id: 'x' }).success, true);
  assert.equal(patch.safeParse({ id: 'x', extra: 1 }).success, false);
});
