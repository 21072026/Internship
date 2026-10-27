// Unit tests for the mentor-limits import's pure half (#1808, part 2) —
// src/lib/mentorLimitsImport.ts: header mapping, cell validation, the diff.
// The engine itself (runImport, the shared parser) is covered by
// scripts/test/roster-ingest.test.mjs; here it runs end to end with a fake
// resolve/apply to pin "the dry run writes nothing".
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const { mapLimitColumns, validateLimitsRow, changedLimits, belowWeeklyCap } = await import('../../src/lib/mentorLimitsImport.ts');
const { parseDelimited, runImport } = await import('../../src/lib/importPreview.ts');

const HEADER = ['email', 'mentorCapacity', 'selfMatchLimit', 'acceptingMentees', 'minNoticeMinutes', 'maxPerMonth'];

test('the issue’s six columns map, case-insensitively and in any order', () => {
  const r = mapLimitColumns(['MaxPerMonth', 'E-Mail', 'selfmatchlimit']);
  assert.ok(r.ok);
  assert.equal(r.map.emailIndex, 1);
  assert.deepEqual(r.map.columns.map((c) => c.field), ['maxPerMonth', 'selfMatchLimit']);
  assert.ok(mapLimitColumns(HEADER).ok);
});

test('the file is refused, with a reason, when the header cannot be read', () => {
  assert.deepEqual(mapLimitColumns(['name', 'mentorCapacity']), { ok: false, code: 'no_email_column' });
  // Hours are not minutes — a near-miss column is refused, not guessed.
  assert.deepEqual(mapLimitColumns(['email', 'minNoticeHours']), { ok: false, code: 'unknown_column', column: 'minNoticeHours' });
  assert.deepEqual(mapLimitColumns(['email', 'maxPerMonth', 'MAXPERMONTH']), { ok: false, code: 'duplicate_column', column: 'MAXPERMONTH' });
  assert.deepEqual(mapLimitColumns(['email']), { ok: false, code: 'no_limit_column' });
});

test('a row is parsed; empty cells are left out, "-" clears', () => {
  const { map } = mapLimitColumns(HEADER);
  assert.deepEqual(validateLimitsRow({ row: 1, values: [' Ada@Example.com ', '6', '3', 'ja', '1440', '8'] }, map), {
    ok: true,
    row: 1,
    key: 'ada@example.com',
    value: { mentorCapacity: 6, selfMatchLimit: 3, acceptingMentees: true, minNoticeMinutes: 1440, maxPerMonth: 8 },
  });
  assert.deepEqual(validateLimitsRow({ row: 2, values: ['b@example.com', '', '-', 'hayır', '', ''] }, map).value, {
    selfMatchLimit: null,
    acceptingMentees: false,
  });
  assert.deepEqual(validateLimitsRow({ row: 3, values: ['c@example.com', '', '', '', '', ''] }, map), {
    ok: false, row: 3, key: 'c@example.com', status: 'SKIP', reason: 'no_values',
  });
});

test('invalid cells make the row an ERROR naming every bad column', () => {
  const { map } = mapLimitColumns(HEADER);
  const r = validateLimitsRow({ row: 4, values: ['d@example.com', '2.5', '101', 'maybe', '99999999', '0'] }, map);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ERROR');
  assert.equal(r.reason, 'mentorCapacity: not_integer; selfMatchLimit: out_of_range; acceptingMentees: not_boolean; minNoticeMinutes: out_of_range; maxPerMonth: out_of_range');
  assert.equal(validateLimitsRow({ row: 5, values: ['nope', '1', '', '', '', ''] }, map).reason, 'invalid_email');
});

test('the diff names only what changes, booking fields against the policy row', () => {
  const current = { mentorCapacity: 6, selfMatchLimit: null, acceptingMentees: true, policy: null };
  assert.deepEqual(changedLimits({ mentorCapacity: 6, selfMatchLimit: 3, minNoticeMinutes: null }, current), ['selfMatchLimit']);
  assert.deepEqual(changedLimits({ minNoticeMinutes: 60 }, current), ['minNoticeMinutes']);
  assert.deepEqual(changedLimits({ maxPerMonth: 4 }, { ...current, policy: { minNoticeMinutes: null, maxPerMonth: 4, maxPerWeek: 2 } }), []);
});

test('a monthly cap below the weekly one is caught', () => {
  const current = { mentorCapacity: null, selfMatchLimit: null, acceptingMentees: null, policy: { minNoticeMinutes: null, maxPerMonth: null, maxPerWeek: 3 } };
  assert.equal(belowWeeklyCap({ maxPerMonth: 2 }, current), true);
  assert.equal(belowWeeklyCap({ maxPerMonth: 3 }, current), false);
  assert.equal(belowWeeklyCap({ maxPerMonth: null }, current), false);
  assert.equal(belowWeeklyCap({ maxPerMonth: 1 }, { ...current, policy: null }), false);
});

test('on the one engine: a dry run reports per row and its writer writes nothing', async () => {
  const text = 'email;selfMatchLimit;maxPerMonth\r\nada@example.com;2;8\r\nghost@example.com;1;\r\nbad;x;\r\n';
  const table = parseDelimited(text);
  const { map } = mapLimitColumns(table.header);
  const writes = [];
  const run = (dryRun) =>
    runImport({
      parse: () => table,
      validate: (row) => validateLimitsRow(row, map),
      resolve: async (rows) => ({
        plan: rows.map((r) =>
          r.key === 'ada@example.com'
            ? { row: r.row, key: r.key, status: 'UPDATE', changed: changedLimits(r.value, { mentorCapacity: null, selfMatchLimit: null, acceptingMentees: null, policy: null }), value: r.value }
            : { row: r.row, key: r.key, status: 'SKIP', reason: 'not_found', value: r.value }
        ),
        absent: [],
      }),
      apply: async (chunk, ctx) => {
        if (!ctx.dryRun) writes.push(...chunk.filter((p) => p.status === 'UPDATE').map((p) => p.key));
        return chunk.map((p) => ({ ...p }));
      },
      dryRun,
    });
  const preview = await run(true);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.rows.map((r) => [r.key, r.status, r.reason ?? r.changed?.join(',')]), [
    ['ada@example.com', 'UPDATE', 'selfMatchLimit,maxPerMonth'],
    ['ghost@example.com', 'SKIP', 'not_found'],
    ['bad', 'ERROR', 'invalid_email'],
  ]);
  assert.deepEqual(writes, []);
  await run(false);
  assert.deepEqual(writes, ['ada@example.com']);
});
