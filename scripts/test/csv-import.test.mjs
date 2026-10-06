// Unit tests for the admin CSV import's row rules (#1432).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The bug these pin: the dry run checked only the e-mail, so a row the real
// run could not write (a 250-character name → Prisma P2000) was promised as
// "create", and the real run then died half-way through the file. The rules
// are now one pure function both modes call; every length is the column's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { parseImportCsv, planImport, rowProblem, parseCsvLine } = await import('../../src/lib/csvImport.ts');
const { TEXT_LIMITS } = await import('../../src/lib/textLimits.ts');

const N = (n) => 'N'.repeat(n);
const statuses = (plan) => plan.map((p) => p.status);

test('a name longer than the column is an error row, and its neighbours are still created', () => {
  const csv = `fullName,email\nGood One,good.one@demo.example.com\n${N(250)},long@demo.example.com\nGood Two,good.two@demo.example.com`;
  const plan = planImport(parseImportCsv(csv), new Set());
  assert.deepEqual(statuses(plan), ['create', 'error', 'create']);
  assert.match(plan[1].reason, /fullName too long/);
  // The data a create row will write already fits its columns.
  for (const p of plan.filter((x) => x.status === 'create')) {
    assert.ok(p.data.fullName.length <= TEXT_LIMITS.userFullName);
  }
});

test('the exact column width is accepted, one more is not — for every capped field', () => {
  const at = { row: 1, email: 'a@demo.example.com', fullName: N(191), phone: N(40), university: N(191), department: N(191) };
  assert.equal(rowProblem(at), null);
  for (const [field, max] of [['fullName', 191], ['phone', 40], ['university', 191], ['department', 191]]) {
    assert.match(rowProblem({ ...at, [field]: N(max + 1) }), new RegExp(`${field} too long`), field);
  }
  assert.equal(rowProblem({ ...at, email: `${N(187)}@x.de` }), 'email too long');
});

test('an address that appears twice in one file is created once and skipped once', () => {
  const plan = planImport(parseImportCsv('A,dup@demo.example.com\nB,DUP@demo.example.com'), new Set());
  assert.deepEqual(statuses(plan), ['create', 'skip']);
  assert.equal(plan[1].reason, 'duplicate in file');
});

test('an address already taken is skipped, matched case-insensitively', () => {
  const plan = planImport(parseImportCsv('A,Taken@Demo.example.com'), new Set(['taken@demo.example.com']));
  assert.deepEqual(plan.map((p) => [p.status, p.reason]), [['skip', 'already exists']]);
});

test('header, BOM, CRLF, blank lines and quoted commas', () => {
  const rows = parseImportCsv('﻿"fullName","email"\r\n\r\n"Doe, Jane",jane@demo.example.com,"+49 1",\r\n  \r\n');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { row: 1, fullName: 'Doe, Jane', email: 'jane@demo.example.com', phone: '+49 1', university: '', department: '' });
  assert.deepEqual(parseCsvLine('"a ""b"" c",d'), ['a "b" c', 'd']);
});

test('a missing name falls back to the local part; missing optional columns are null', () => {
  const [p] = planImport(parseImportCsv(',solo@demo.example.com'), new Set());
  assert.deepEqual(p.data, { email: 'solo@demo.example.com', fullName: 'solo', phone: null, university: null, department: null });
});

test('fuzz: no input shape throws, and every row gets exactly one verdict', () => {
  const pieces = ['', ',', '"', '""', 'x', N(300), 'a@b.co', ' @ ', '﻿', 'email', '"a,b"', '\t', 'ü@ö.de'];
  let seed = 1;
  const rnd = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  for (let k = 0; k < 2000; k++) {
    const lines = Array.from({ length: rnd(6) }, () => Array.from({ length: rnd(7) }, () => pieces[rnd(pieces.length)]).join(rnd(2) ? ',' : ''));
    const csv = lines.join(rnd(2) ? '\n' : '\r\n');
    const rows = parseImportCsv(csv);
    const plan = planImport(rows, new Set());
    assert.equal(plan.length, rows.length);
    for (const p of plan) {
      assert.ok(['create', 'skip', 'error'].includes(p.status));
      if (p.status === 'create') assert.equal(rowProblem({ row: p.row, ...p.data }), null);
    }
  }
});
