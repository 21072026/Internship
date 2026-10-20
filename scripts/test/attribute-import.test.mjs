// Unit tests for the attribute-value import's pure half (#1920, part 2) —
// src/lib/attributeImport.ts: header → attribute mapping, row validation.
// The engine itself (runImport, the shared parser) is covered by
// scripts/test/roster-ingest.test.mjs.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const { mapColumns, validateAttributeRow, changedAttributes } = await import('../../src/lib/attributeImport.ts');

const dept = { id: 'a1', key: 'department', labelEn: 'Department', labelTr: 'Bölüm', labelDe: 'Abteilung', type: 'SELECT', options: ['Engineering', 'Sales'] };
const start = { id: 'a2', key: 'start_date', labelEn: 'Start date', labelTr: '', labelDe: '', type: 'DATE', options: null };
const attrs = [dept, start];

test('columns map by key or by a label in any language, case-insensitively', () => {
  const r = mapColumns(['E-Mail', 'BÖLÜM', 'start_date'], attrs);
  assert.ok(r.ok);
  assert.equal(r.map.emailIndex, 0);
  assert.deepEqual(r.map.columns.map((c) => c.attribute.key), ['department', 'start_date']);
});

test('the file is refused, with a reason, when the header cannot be read', () => {
  assert.deepEqual(mapColumns(['name', 'department'], attrs), { ok: false, code: 'no_email_column' });
  assert.deepEqual(mapColumns(['email', 'deparment'], attrs), { ok: false, code: 'unknown_column', column: 'deparment' });
  assert.deepEqual(mapColumns(['email', 'department', 'Abteilung'], attrs), { ok: false, code: 'duplicate_column', column: 'Abteilung' });
  assert.deepEqual(mapColumns(['email'], attrs), { ok: false, code: 'no_attribute_column' });
});

test('a row is normalised; empty cells are left out, never cleared', () => {
  const { map } = mapColumns(['email', 'department', 'start_date'], attrs);
  assert.deepEqual(validateAttributeRow({ row: 1, values: [' Ada@Example.com ', 'engineering', '1.3.2024'] }, map), {
    ok: true,
    row: 1,
    key: 'ada@example.com',
    value: { a1: 'Engineering', a2: '2024-03-01' },
  });
  assert.deepEqual(validateAttributeRow({ row: 2, values: ['b@example.com', 'Sales', ''] }, map).value, { a1: 'Sales' });
});

test('invalid cells make the row an ERROR naming every bad column', () => {
  const { map } = mapColumns(['email', 'department', 'start_date'], attrs);
  const r = validateAttributeRow({ row: 3, values: ['c@example.com', 'Legal', 'soon'] }, map);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ERROR');
  assert.equal(r.reason, 'department: not_an_option; start_date: not_a_date');
  assert.equal(validateAttributeRow({ row: 4, values: ['nope', 'Sales', ''] }, map).reason, 'invalid_email');
  assert.equal(validateAttributeRow({ row: 5, values: ['d@example.com', '', ''] }, map).status, 'SKIP');
});

test('only values that differ from the stored ones count as changes', () => {
  assert.deepEqual(changedAttributes({ a1: 'Sales', a2: '2024-03-01' }, new Map([['a1', 'Sales']])), ['a2']);
  assert.deepEqual(changedAttributes({ a1: 'Sales' }, new Map([['a1', 'Sales']])), []);
});
