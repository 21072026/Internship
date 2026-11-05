// zod 4 keeps zod 3's default messages (#3558).
//
// zod 4 ships the zod 3 implementation as `zod/v3`, so the wording is not
// remembered here but MEASURED: every case builds the same schema in both
// versions, parses the same input, and the issues must carry the same message
// at the same path. A case that drifts names the schema and the input.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { z: z4 } = await import('zod');
const { z: z3 } = await import('zod/v3');
const { installZodV3Messages } = await import('../../src/lib/zodV3Messages.ts');

installZodV3Messages();

/** [label, (z) => schema, input] — the schema is built from whichever z is passed. */
const CASES = [
  ['missing required string', (z) => z.object({ a: z.string() }), {}],
  ['string received number', (z) => z.string(), 5],
  ['string received null', (z) => z.string(), null],
  ['number received string', (z) => z.number(), 'x'],
  ['number received NaN', (z) => z.number(), Number.NaN],
  ['boolean received string', (z) => z.boolean(), 'yes'],
  ['array received object', (z) => z.array(z.string()), {}],
  ['object received array', (z) => z.object({}), []],
  ['int received float', (z) => z.number().int(), 1.5],
  ['email', (z) => z.string().email(), 'not-an-email'],
  ['url', (z) => z.string().url(), 'not a url'],
  ['uuid', (z) => z.string().uuid(), 'nope'],
  ['datetime', (z) => z.string().datetime(), '2026-13-99'],
  ['regex', (z) => z.string().regex(/^\d+$/), 'abc'],
  ['startsWith', (z) => z.string().startsWith('ab'), 'xx'],
  ['endsWith', (z) => z.string().endsWith('yz'), 'xx'],
  ['string min', (z) => z.string().min(3), 'ab'],
  ['string min 1', (z) => z.string().min(1), ''],
  ['string max', (z) => z.string().max(2), 'abc'],
  ['string length', (z) => z.string().length(2), 'abc'],
  ['number min', (z) => z.number().min(5), 4],
  ['number positive', (z) => z.number().positive(), 0],
  ['number max', (z) => z.number().max(5), 6],
  ['number negative', (z) => z.number().negative(), 0],
  ['number multipleOf', (z) => z.number().multipleOf(5), 7],
  ['array min', (z) => z.array(z.string()).min(2), ['a']],
  ['array max', (z) => z.array(z.string()).max(1), ['a', 'b']],
  ['array nonempty', (z) => z.array(z.string()).nonempty(), []],
  ['literal', (z) => z.literal('on'), 'off'],
  ['literal true', (z) => z.literal(true), false],
  ['enum', (z) => z.enum(['a', 'b']), 'c'],
  ['strict unknown key', (z) => z.object({ a: z.string() }).strict(), { a: 'x', b: 1, c: 2 }],
  ['union', (z) => z.union([z.string(), z.number()]), true],
  ['refine default message', (z) => z.string().refine((v) => v === 'ok'), 'no'],
  ['nested path', (z) => z.object({ list: z.array(z.object({ n: z.number() })) }), { list: [{ n: 1 }, { n: 'x' }] }],
  ['schema message wins', (z) => z.string().min(1, 'Company name is required'), ''],
  ['optional absent is fine, present is checked', (z) => z.object({ a: z.string().optional() }), { a: 1 }],
  ['nullable wrong type', (z) => z.string().nullable(), 1],
];

const issuesOf = (z, build, input) => {
  const result = build(z).safeParse(input);
  assert.equal(result.success, false, 'every case must fail to parse');
  return result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
};

for (const [label, build, input] of CASES) {
  test(`zod 4 words "${label}" as zod 3 did`, () => {
    assert.deepEqual(issuesOf(z4, build, input), issuesOf(z3, build, input), `${label}: ${JSON.stringify(input)}`);
  });
}

test('a schema-level message still wins over the map', () => {
  const r = z4.string({ error: 'invalid_type' }).safeParse(1);
  assert.equal(r.success, false);
  assert.equal(r.error.issues[0].message, 'invalid_type');
});
