#!/usr/bin/env node
/**
 * Import the marketing team's account spreadsheet (CSV) into the CRM (#2406).
 *
 * Usage (dry-run is the DEFAULT — nothing is written without --apply):
 *   npm run import:marketing-accounts -- --file=accounts.csv --owner=admin@example.com
 *   npm run import:marketing-accounts -- --file=accounts.csv --owner=admin@example.com --apply
 *
 *   --file=<path>        the delimited file (required)
 *   --owner=<email>      an ADMIN or MENTOR; their organization is the run's
 *                        organization and they own every funnel record whose
 *                        row names no owner_email (required)
 *   --apply              write; without it the run reports and touches nothing
 *   --authoritative      let the file overwrite a value it disagrees with.
 *                        Off by default: the file only fills gaps, so a value
 *                        somebody corrected in the app survives a re-run.
 *   --delimiter=<c>      , ; \t or | — sniffed from the header line otherwise
 *   --report=<path>      write the full per-row report as JSON, including the
 *                        columns that have no database column yet
 *   --rows=<n>           how many per-row lines to print (default 20)
 *
 * The column contract is docs/marketing-import.md. There is NO tenant column:
 * one run is one organization, the one that owns --owner.
 *
 * Run through `node --experimental-strip-types` (the npm script does): the
 * engine, the diff and the writes live in TypeScript under src/lib and this
 * file only reads argv and prints. It deliberately carries NO parsing and NO
 * dry-run branch of its own — `scripts/import-csv.mjs`'s own `csv-parse` usage
 * is the legacy shape docs/roster-feed.md forbids repeating.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';

// The app's modules import each other as `./importPreview` and `@/lib/…`, which
// Node's ESM resolver does not resolve; this hook closes that one gap and must
// be installed before the modules load, hence the dynamic import below.
register(new URL('./test/ts-extensionless-resolve.mjs', import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(2);
}

if (!args.file || args.file === true) fail('Provide --file=<path>');
if (!args.owner || args.owner === true) fail('Provide --owner=<email of an ADMIN or MENTOR>');

const { runMarketingAccountImport, MarketingImportError } = await import(
  '../src/lib/marketingImportStore.ts'
);
const { MARKETING_IMPORT_COLUMNS, MARKETING_COLUMNS_WITHOUT_TARGET } = await import(
  '../src/lib/marketingImport.ts'
);

const APPLY = args.apply === true;
const maxRows = Number(args.rows ?? 20);

let result;
try {
  result = await runMarketingAccountImport({
    text: readFileSync(String(args.file), 'utf8'),
    ownerEmail: String(args.owner),
    apply: APPLY,
    authoritative: args.authoritative === true,
    ...(typeof args.delimiter === 'string' ? { delimiter: args.delimiter } : {}),
  });
} catch (error) {
  if (error instanceof MarketingImportError) fail(`${error.code}: ${error.message}`);
  throw error;
}

const { owner, report, stageKeys } = result;

console.log(`\n=== Marketing account import ${APPLY ? '(APPLY)' : '(DRY-RUN — no writes)'} ===`);
console.log(`File            : ${args.file}`);
console.log(`Owner           : ${owner.email} (${owner.role})`);
console.log(`Organization    : ${owner.orgId ?? '(none — single-tenant)'}`);
console.log(`Pipeline stages : ${stageKeys.join(', ')}`);
console.log(`Field policy    : ${args.authoritative === true ? 'authoritative (overwrites)' : 'fill gaps only'}`);
console.log(`Columns known   : ${MARKETING_IMPORT_COLUMNS.map((c) => c.header).join(', ')}`);
console.log(
  `Not stored yet  : ${MARKETING_COLUMNS_WITHOUT_TARGET.join(', ')} — validated and carried in --report, no column yet (channels: #2408)`,
);

console.log(`\nRows: ${report.total}`);
for (const [status, count] of Object.entries(report.counts)) console.log(`  ${status}: ${count}`);

const notable = report.rows.filter((r) => r.status === 'ERROR' || r.status === 'SKIP' || r.reason);
if (notable.length > 0) {
  console.log(`\nRows needing attention (${notable.length}):`);
  for (const row of notable.slice(0, maxRows)) {
    console.log(`  row ${row.row} [${row.status}] ${row.key} — ${row.reason ?? ''}`);
  }
  if (notable.length > maxRows) console.log(`  … ${notable.length - maxRows} more (raise --rows or use --report)`);
}

const sample = report.rows.filter((r) => r.status === 'CREATE' || r.status === 'UPDATE').slice(0, 5);
if (sample.length > 0) {
  console.log('\nSample of what would be written:');
  for (const row of sample) {
    console.log(`  row ${row.row} [${row.status}] ${row.value?.input.name} → ${(row.changed ?? []).join(', ') || '(nothing)'}`);
  }
}

if (typeof args.report === 'string') {
  writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nFull report written to ${args.report}`);
}

if (!APPLY) {
  console.log('\n(Dry-run only. Re-run with --apply to write.)');
}

// A partially applied import must not exit 0: this is a manual run by a human
// who needs to see that some rows did not land.
if (report.counts.ERROR > 0) process.exitCode = 1;

// The client is a module-level singleton, so the pool keeps the process alive.
const { prisma } = await import('../src/lib/prisma.ts');
await prisma.$disconnect();
