// `{ error: '…' }` is the zod 4 name of the deprecated `{ message: '…' }`
// parameter (#3568). Part 4 renamed it on 25 `.refine()` calls; this pins that
// the refusal carries the same message and path either way, so the rename can
// never change what a 400 response says.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

test('refine(fn, { error, path }) refuses exactly like refine(fn, { message, path })', () => {
  const legacy = z.object({ a: z.number(), b: z.number() }).refine((v) => v.a < v.b, { message: 'a must be below b', path: ['b'] });
  const current = z.object({ a: z.number(), b: z.number() }).refine((v) => v.a < v.b, { error: 'a must be below b', path: ['b'] });
  const pick = (r) => r.error.issues.map(({ code, message, path }) => ({ code, message, path }));
  assert.deepEqual(pick(current.safeParse({ a: 2, b: 1 })), pick(legacy.safeParse({ a: 2, b: 1 })));
  assert.equal(current.safeParse({ a: 1, b: 2 }).success, true);
});

// Part 4 also moved the four `.superRefine(fn)` calls to `.check(z.superRefine(fn))`
// — the same callback with the same ctx, which is how zod 4 implements the
// deprecated method — and `z.ZodIssueCode.custom` to the literal 'custom'.
test('.check(z.superRefine(fn)) reports exactly like .superRefine(fn)', () => {
  const fn = (v, ctx) => {
    if (v.a < 0) ctx.addIssue({ code: 'custom', path: ['a'], message: 'negative' });
  };
  const legacy = z.object({ a: z.number() }).superRefine(fn);
  const current = z.object({ a: z.number() }).check(z.superRefine(fn));
  for (const input of [{ a: -1 }, { a: 1 }, { a: 'x' }, null]) {
    assert.deepEqual(JSON.stringify(current.safeParse(input)), JSON.stringify(legacy.safeParse(input)), JSON.stringify(input));
  }
  assert.equal(z.ZodIssueCode.custom, 'custom');
});
