// The erasure-coverage guard (#2098): every free-text column needs a decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check, textColumns } from '../check-erasure-coverage.mjs';

const schema = `
model Note {
  id    String @id
  // body String @db.Text  ← a comment, not a column
  body  String  @db.Text
  extra String? @db.LongText
  name  String
}
`;

test('finds Text columns and skips comments and plain strings', () => {
  assert.deepEqual(textColumns(schema), ['Note.body', 'Note.extra']);
});

test('an undecided column fails, a decided one passes', () => {
  const src = 'prisma.note.updateMany({ data: { body: "" } })';
  const decided = new Map([['Note.body', 'ERASED'], ['Note.extra', 'config, not a person']]);
  assert.deepEqual(check(schema, src, decided).errors, []);
  const missing = check(schema, src, new Map([['Note.body', 'ERASED']])).errors;
  assert.equal(missing.length, 1);
  assert.match(missing[0], /^Note\.extra: a free-text column with no erasure decision/);
});

test('ERASED is checked against the erasure source', () => {
  const decided = new Map([['Note.body', 'ERASED'], ['Note.extra', 'ERASED']]);
  const errors = check(schema, 'prisma.note.updateMany({ data: { body: "" } })', decided).errors;
  assert.deepEqual(errors.map((e) => e.split(':')[0]), ['Note.extra']);
  // A deleteMany of the model reaches every column on it.
  assert.deepEqual(check(schema, 'prisma.note.deleteMany({})', decided).errors, []);
});

test('a stale entry fails', () => {
  const decided = new Map([['Note.body', 'x'], ['Note.extra', 'x'], ['Gone.text', 'x']]);
  assert.match(check(schema, '', decided).errors[0], /^Gone\.text: listed here but not a free-text column/);
});

test('the real schema is fully decided', () => {
  const files = ['accountErasure', 'companyContactErasure', 'externalProfileErasure', 'outboundDrafts', 'googleCalendarClient'];
  const src = files.map((f) => readFileSync(`src/lib/${f}.ts`, 'utf8')).join('\n');
  assert.deepEqual(check(readFileSync('prisma/schema.prisma', 'utf8'), src).errors, []);
});
