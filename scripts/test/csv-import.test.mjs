// Unit tests for the admin CSV import (#1432), on the shared engine (#2072).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The bug these pin: the dry run checked only the e-mail, so a row the real
// run could not write (a 250-character name → Prisma P2000) was promised as
// "create", and the real run then died half-way through the file. The rules
// are one set of hooks both modes run through `runImport`; every length is the
// column's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { parseImportCsv, candidateTable, validateCandidate, planCandidates, rowProblem } = await import('../../src/lib/csvImport.ts');
const { runImport } = await import('../../src/lib/importPreview.ts');
const { TEXT_LIMITS } = await import('../../src/lib/textLimits.ts');

const N = (n) => 'N'.repeat(n);

/**
 * The route's hooks with an in-memory store instead of Prisma: `taken` is what
 * already exists, `failOn` an address whose write throws (a dying database).
 */
function hooks(csv, { taken = new Set(), failOn = null, store = [] } = {}, dryRun = false) {
  return {
    dryRun,
    parse: () => candidateTable(csv),
    validate: (row) => validateCandidate(row),
    resolve: async (rows) => ({ plan: planCandidates(rows, taken), absent: [] }),
    apply: async (chunk, ctx) =>
      chunk.map((p) => {
        const result = { row: p.row, key: p.key, status: p.status, reason: p.reason, value: p.value };
        if (ctx.dryRun || p.status !== 'CREATE') return result;
        if (p.value.data.email === failOn) return { ...result, status: 'ERROR', reason: 'could not be saved' };
        store.push(p.value.data.email);
        return result;
      }),
  };
}
const statuses = (report) => report.rows.map((r) => r.status);

test('a name longer than the column is an error row, and its neighbours are still created', async () => {
  const csv = `fullName,email\nGood One,good.one@demo.example.com\n${N(250)},long@demo.example.com\nGood Two,good.two@demo.example.com`;
  const report = await runImport(hooks(csv, {}, true));
  assert.deepEqual(statuses(report), ['CREATE', 'ERROR', 'CREATE']);
  assert.match(report.rows[1].reason, /fullName too long/);
  // The data a create row will write already fits its columns.
  for (const r of report.rows.filter((x) => x.status === 'CREATE')) assert.ok(r.value.data.fullName.length <= TEXT_LIMITS.userFullName);
});

test('the exact column width is accepted, one more is not — for every capped field', () => {
  const at = { row: 1, email: 'a@demo.example.com', fullName: N(191), phone: N(40), university: N(191), department: N(191) };
  assert.equal(rowProblem(at), null);
  for (const [field, max] of [['fullName', 191], ['phone', 40], ['university', 191], ['department', 191]]) {
    assert.match(rowProblem({ ...at, [field]: N(max + 1) }), new RegExp(`${field} too long`), field);
  }
  assert.equal(rowProblem({ ...at, email: `${N(187)}@x.de` }), 'email too long');
});

test('a mixed file: the dry run promises exactly what the real run writes', async () => {
  // good / over-length / duplicate-in-file / already-exists / malformed / good
  const csv = [
    'fullName,email,phone',
    'Ada,ada@demo.example.com,',
    `${N(250)},long@demo.example.com,`,
    'Ada Again,ADA@demo.example.com,',
    'Old,taken@demo.example.com,',
    'Broken,not-an-email,',
    'Bo,bo@demo.example.com,',
  ].join('\n');
  const taken = new Set(['taken@demo.example.com']);
  const dry = await runImport(hooks(csv, { taken }, true));
  const store = [];
  const real = await runImport(hooks(csv, { taken, store }, false));
  assert.deepEqual(statuses(dry), ['CREATE', 'ERROR', 'SKIP', 'SKIP', 'ERROR', 'CREATE']);
  assert.deepEqual(dry.rows.map((r) => r.reason ?? null).slice(2, 4), ['duplicate in file', 'already exists']);
  assert.equal(real.counts.CREATE, dry.counts.CREATE);
  assert.deepEqual(statuses(real), statuses(dry));
  assert.deepEqual(store, ['ada@demo.example.com', 'bo@demo.example.com']);
});

test('header in any column order, BOM, CRLF, blank lines, quoted commas, a quoted newline and `;`', () => {
  const rows = parseImportCsv('﻿"email";"fullName"\r\n\r\njane@demo.example.com;"Doe; Jane"\r\n  \r\n');
  assert.deepEqual(rows, [{ row: 1, fullName: 'Doe; Jane', email: 'jane@demo.example.com', phone: '', university: '', department: '' }]);
  const quoted = parseImportCsv('"Doe, Jane",jane@demo.example.com,"+49 1","Uni\nof Life"');
  assert.deepEqual(quoted[0], { row: 1, fullName: 'Doe, Jane', email: 'jane@demo.example.com', phone: '+49 1', university: 'Uni\nof Life', department: '' });
});

test('without a header the first line is data, positional', () => {
  const rows = parseImportCsv(',solo@demo.example.com\nSecond,second@demo.example.com');
  assert.deepEqual(rows.map((r) => [r.row, r.email]), [[1, 'solo@demo.example.com'], [2, 'second@demo.example.com']]);
  const [plan] = planCandidates([{ row: 1, key: rows[0].email, value: rows[0] }], new Set());
  // A missing name falls back to the local part; missing optional columns are null.
  assert.deepEqual(plan.value.data, { email: 'solo@demo.example.com', fullName: 'solo', phone: null, university: null, department: null });
});

test('fuzz: 5 000 rows of every awkward shape, one failing write — never a throw, always a full report', async () => {
  const pieces = ['', ',', '"', '""', 'x', N(250), 'a@b.co', ' @ ', '﻿', 'email', '"a,b"', '\t', 'ü@ö.de', ';'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  const lines = ['fullName,email,phone,university,department'];
  for (let k = 0; k < 5000; k++) {
    const kind = rnd(5);
    if (kind === 0) lines.push(`Person ${k},p${k}@demo.example.com,${N(rnd(2) ? 10 : 250)},Uni,CS`);
    else if (kind === 1) lines.push(`"Last, First ${k}",q${k}@demo.example.com`);
    else if (kind === 2) lines.push('');
    else if (kind === 3) lines.push(`only-one-column-${k}`);
    else lines.push(Array.from({ length: rnd(7) }, () => pieces[rnd(pieces.length)]).join(rnd(2) ? ',' : ''));
  }
  const csv = '﻿' + lines.join(rnd(2) ? '\n' : '\r\n');
  const store = [];
  const report = await runImport(hooks(csv, { failOn: 'p0@demo.example.com', store }, false));
  assert.equal(report.rows.length, report.total);
  const counts = report.rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  for (const s of ['CREATE', 'SKIP', 'ERROR']) assert.equal(report.counts[s], counts[s] ?? 0);
  // What was written is exactly the CREATE rows; the failing write is an ERROR row.
  assert.equal(store.length, report.counts.CREATE);
  const failed = report.rows.find((r) => r.key === 'p0@demo.example.com');
  if (failed) assert.equal(failed.status, 'ERROR');
  for (const r of report.rows.filter((x) => x.status === 'CREATE')) assert.equal(rowProblem({ row: r.row, ...r.value.data }), null);
});
