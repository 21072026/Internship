// Unit tests for org-defined segmentation attributes (#1920) —
// src/lib/orgAttributesRule.ts: key shape, value normalisation per type,
// label fallback and the derived (never stored) tenure buckets.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const {
  isAttributeKey,
  isAttributeType,
  isAttributeTarget,
  keyFromLabel,
  normalizeOptions,
  normalizeValue,
  attributeLabel,
  tenureBucket,
} = await import('../../src/lib/orgAttributesRule.ts');

test('keys are lower-case identifiers, max 64', () => {
  assert.ok(isAttributeKey('department'));
  assert.ok(isAttributeKey('start_date2'));
  assert.ok(!isAttributeKey('Department'));
  assert.ok(!isAttributeKey('2nd'));
  assert.ok(!isAttributeKey('a-b'));
  assert.ok(!isAttributeKey('a'.repeat(65)));
});

test('only the whitelisted types and targets', () => {
  assert.ok(isAttributeType('SELECT') && isAttributeType('DATE'));
  assert.ok(!isAttributeType('GENDER'));
  assert.ok(isAttributeTarget('USER'));
  assert.ok(!isAttributeTarget('RELATION'), 'RELATION is reserved, not writable yet');
});

test('a key is derived from a label in any of the three languages', () => {
  assert.equal(keyFromLabel('Department'), 'department');
  assert.equal(keyFromLabel('Başlangıç tarihi'), 'baslangic_tarihi');
  assert.equal(keyFromLabel('Größe / Ebene'), 'grosse_ebene');
  assert.equal(keyFromLabel('2024 Kohorte'), 'kohorte');
  assert.equal(keyFromLabel('!!!'), null);
});

test('options are trimmed, de-duplicated case-insensitively, non-strings dropped', () => {
  assert.deepEqual(normalizeOptions([' Engineering ', 'engineering', '', 3, 'Sales']), ['Engineering', 'Sales']);
  assert.deepEqual(normalizeOptions('nope'), []);
});

test('SELECT values must match an option and take its spelling', () => {
  const attr = { type: 'SELECT', options: ['Engineering', 'Sales'] };
  assert.deepEqual(normalizeValue(attr, ' engineering '), { ok: true, value: 'Engineering' });
  assert.deepEqual(normalizeValue(attr, 'Legal'), { ok: false, code: 'not_an_option' });
  assert.deepEqual(normalizeValue(attr, '  '), { ok: false, code: 'empty' });
});

test('DATE accepts ISO and DD.MM.YYYY, refuses impossible dates', () => {
  const attr = { type: 'DATE' };
  assert.deepEqual(normalizeValue(attr, '2024-02-29'), { ok: true, value: '2024-02-29' });
  assert.deepEqual(normalizeValue(attr, '1.3.2023'), { ok: true, value: '2023-03-01' });
  assert.deepEqual(normalizeValue(attr, '2023-02-29'), { ok: false, code: 'not_a_date' });
  assert.deepEqual(normalizeValue(attr, 'yesterday'), { ok: false, code: 'not_a_date' });
});

test('NUMBER accepts a decimal comma and stores the plain form', () => {
  const attr = { type: 'NUMBER' };
  assert.deepEqual(normalizeValue(attr, '3,5'), { ok: true, value: '3.5' });
  assert.deepEqual(normalizeValue(attr, 7), { ok: true, value: '7' });
  assert.deepEqual(normalizeValue(attr, '007'), { ok: true, value: '7' });
  assert.deepEqual(normalizeValue(attr, '1e3'), { ok: false, code: 'not_a_number' });
});

test('TEXT is trimmed and capped', () => {
  assert.deepEqual(normalizeValue({ type: 'TEXT' }, '  Berlin '), { ok: true, value: 'Berlin' });
  assert.deepEqual(normalizeValue({ type: 'TEXT' }, 'x'.repeat(192)), { ok: false, code: 'too_long' });
});

test('labels fall back EN → TR → DE → key', () => {
  const attr = { key: 'dept', labelEn: 'Department', labelTr: 'Bölüm', labelDe: '' };
  assert.equal(attributeLabel(attr, 'tr'), 'Bölüm');
  assert.equal(attributeLabel(attr, 'de'), 'Department');
  assert.equal(attributeLabel({ key: 'dept', labelEn: '', labelTr: '', labelDe: '' }, 'en'), 'dept');
});

test('tenure is derived from a start date against now', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  assert.equal(tenureBucket('2026-01-01', now), 'lt1y');
  assert.equal(tenureBucket('2025-10-20', now), '1to3y');
  assert.equal(tenureBucket('2025-10-21', now), 'lt1y');
  assert.equal(tenureBucket('2022-01-01', now), '3to5y');
  assert.equal(tenureBucket('2021-10-20', now), 'gte5y');
  assert.equal(tenureBucket('2027-01-01', now), null, 'a future start has no tenure');
  assert.equal(tenureBucket('garbage', now), null);
});
