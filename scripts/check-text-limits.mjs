// Every zod cap must fit the column behind it (#1433, #2262).
//
// WHY IN CI AND NOT ONLY IN THE TEST
//   The invariant is stated in the header of src/lib/textLimits.ts:
//
//     server cap > column width -> Prisma P2000 ("Data too long"), which no
//     route handles, so it surfaces as a 500.
//
//   It was checked only by e2e/text-limits-columns.unit.spec.ts, which runs in
//   the scheduled full suite — so a too-wide cap merged green and first showed
//   up as a 500 for whoever pasted a long line. It reads nothing but files, so
//   there is no reason for it to need a browser or a database. This runs it in
//   the PR gate, off the same registry the spec uses (src/lib/textLimitsRegistry.ts),
//   so the two cannot drift into disagreeing.
//
// WHAT IT CHECKS, for every model in the registry, in both directions:
//   1. every String column of the model is accounted for — a constant, or an
//      exemption carrying a reason;
//   2. no entry for a column the schema no longer has (a stale row silently
//      stops testing anything);
//   3. the constant fits the column, with the width parsed out of
//      prisma/schema.prisma rather than retyped;
//   4. every file named by a guard actually references the constant, so a route
//      cannot go back to an inline number.
//
// WHAT IT DOES NOT CHECK — see the registry's header. A model absent from the
// registry is not examined at all, and a TEXT_LIMITS constant with no row there
// is not required to have one. Neither is silent: both are stated, and adding a
// model is a one-line change.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const schemaSource = readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');

// Imported under Node's type stripping (the repo already does this for
// check-i18n.ts and scripts/test/*.test.mjs); the '@/' alias does not resolve
// here, which is why both files are import-free apart from a type.
const { TEXT_LIMITS } = await import(pathToFileURL(path.join(root, 'src/lib/textLimits.ts')).href);
const { COLUMN_GUARDS } = await import(pathToFileURL(path.join(root, 'src/lib/textLimitsRegistry.ts')).href);

/**
 * Every `String` column of one model, with its width. A `String` with no `@db.`
 * attribute is VARCHAR(191) in MySQL — that default is exactly what makes a
 * too-wide cap invisible in review, so it is spelled out.
 */
function stringColumns(model) {
  const block = new RegExp(`^model ${model} \\{$([\\s\\S]*?)^\\}$`, 'm').exec(schemaSource);
  if (!block) return null;
  const columns = [];
  for (const line of block[1].split('\n')) {
    const match = /^\s+(\w+)\s+String\??\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, attrs] = match;
    if (/@db\.(Text|MediumText|LongText)/.test(attrs)) {
      columns.push({ name, kind: 'text' });
      continue;
    }
    const explicit = /@db\.VarChar\((\d+)\)/.exec(attrs);
    columns.push({ name, kind: 'varchar', width: explicit ? Number(explicit[1]) : 191 });
  }
  return columns;
}

// @db.Text is 65 535 BYTES; utf8mb4 Turkish/German runs 2-3 bytes per non-ASCII
// character, so the limits file caps TEXT-backed fields at 20 000 characters.
const TEXT_CHAR_BUDGET = 20000;

const problems = [];
const fileCache = new Map();
let checkedColumns = 0;
let checkedFiles = 0;

for (const [model, guards] of Object.entries(COLUMN_GUARDS)) {
  const columns = stringColumns(model);
  if (!columns) {
    problems.push(`model ${model} is in the registry but not in prisma/schema.prisma`);
    continue;
  }
  if (columns.length === 0) {
    problems.push(`model ${model} has no String columns — drop it from the registry`);
    continue;
  }

  for (const name of columns.map((c) => c.name)) {
    if (!(name in guards)) {
      problems.push(
        `${model}.${name} is not accounted for — add the TEXT_LIMITS key that bounds it in every ` +
          `schema that writes it, or an exemption with a reason`
      );
    }
  }
  for (const name of Object.keys(guards)) {
    if (!columns.some((c) => c.name === name)) {
      problems.push(`${model}.${name} is in the registry but no longer a String column — drop it`);
    }
  }

  for (const column of columns) {
    const guard = guards[column.name];
    if (!guard || 'exempt' in guard) continue;
    const limit = TEXT_LIMITS[guard.limit];
    checkedColumns += 1;
    if (limit === undefined) {
      problems.push(`${model}.${column.name} names TEXT_LIMITS.${guard.limit}, which does not exist`);
      continue;
    }
    if (column.kind === 'text') {
      if (limit > TEXT_CHAR_BUDGET) {
        problems.push(
          `TEXT_LIMITS.${guard.limit} is ${limit}, past the ${TEXT_CHAR_BUDGET}-character budget for the ` +
            `@db.Text column ${model}.${column.name} (65 535 BYTES, 2-3 bytes per non-ASCII character)`
        );
      }
    } else if (limit > column.width) {
      problems.push(
        `TEXT_LIMITS.${guard.limit} is ${limit} but ${model}.${column.name} is VARCHAR(${column.width}) — ` +
          `long input passes validation and dies in the INSERT with P2000, which surfaces as a 500`
      );
    }

    for (const file of guard.files) {
      const key = `${file}::${guard.limit}`;
      if (fileCache.has(key)) continue;
      fileCache.set(key, true);
      checkedFiles += 1;
      let source;
      try {
        source = readFileSync(path.join(root, file), 'utf8');
      } catch {
        problems.push(`${model}.${column.name} names ${file}, which does not exist`);
        continue;
      }
      if (!source.includes(`TEXT_LIMITS.${guard.limit}`)) {
        problems.push(
          `${file} must cap with TEXT_LIMITS.${guard.limit} rather than a literal (it guards ${model}.${column.name})`
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`text limits FAILED — ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error(
    '\nThe rule, from the header of src/lib/textLimits.ts: a zod cap wider than its column is a 500\n' +
      'waiting for the first long paste. Fix the BOUND, not the column, unless the column is genuinely\n' +
      'too narrow for legitimate input — and register the field in src/lib/textLimitsRegistry.ts.'
  );
  process.exit(1);
}

console.log(
  `text limits OK — ${Object.keys(COLUMN_GUARDS).length} model(s) registered, ${checkedColumns} bounded ` +
    `column(s) fit their width, ${checkedFiles} guard file reference(s) intact.`
);
