#!/usr/bin/env node
// Guard: a schema change that `prisma db push` cannot apply to a table that
// already has rows (#2298).
//
// WHY THIS EXISTS
//   #2249 added `Setting.id String @id @default(cuid())`. Additive in the
//   schema, green on every check the author could see — and it stalled every
//   prod and preview deploy for 13 commits, because `db push` does not merely
//   warn about this step, it refuses to run it:
//
//     The required column `id` was added to the `Setting` table with a
//     prisma-level default value. There are 8 rows in this table, it is not
//     possible to execute this step.
//
//   `--accept-data-loss` does not cover that class. It is a *cannot execute*,
//   not a data-loss warning, so the deploy stops with the old container still
//   serving and nothing gets through until someone writes an expand/backfill/
//   contract script by hand.
//
//   The reason no existing gate caught it is the whole point: a topic
//   environment pushes against a FRESH database (#1185), where the very same
//   step is perfectly legal. So the diff looks harmless everywhere the author
//   can look, and only bites the first environment that has rows. CLAUDE.md
//   said schema changes must be "additive", which is exactly what the author
//   believed they were doing — the word does not distinguish "adds a column"
//   from "adds a column MySQL cannot fill".
//
//   This compares prisma/schema.prisma against the merge-base with origin/main
//   and fails on the steps that are refused on a populated table:
//
//     1. a required field added to a model that EXISTS ON BOTH SIDES whose
//        default is client-side — cuid()/uuid()/ulid()/nanoid()/auto(): Prisma
//        generates those values in the application, so the ALTER TABLE has
//        nothing to put in the existing rows;
//     2. the same, with no default at all — a NOT NULL column and no value;
//     3. a new or changed primary key (`@id` / `@@id`) — resolved as
//        DROP + CREATE, which for a populated table is refused or destructive.
//
//   Deliberately NOT failed: nullable fields (existing rows get NULL); required
//   fields with a literal or DB-resolvable default (`@default(0)`, `@default("x")`,
//   `@default(false)`, `@default(now())`, `@default(autoincrement())`,
//   `@default(dbgenerated(…))` — MySQL fills those itself); anything on a
//   brand-new model (no rows yet, by definition); a pure `@@index` change.
//
//   A new `@unique`/`@@unique` over columns that already exist is reported as a
//   WARNING, not a failure: it fails only if the existing rows happen to hold
//   duplicates, which this script cannot know, and a gate that goes red on a
//   maybe is a gate people learn to ignore.
//
//   Out of scope on purpose: a column that goes from nullable to required is
//   the same family of failure (it breaks if any row holds NULL) but the
//   refusal is data-dependent rather than categorical, so it is left to review
//   rather than guessed at here.
//
// HOW TO FIX A FINDING
//   Not by relaxing this script. The shape is expand → backfill → contract, and
//   prisma/push-company-interest-expand.mjs is the worked example that lives in
//   the tree: converge on an intermediate schema the live table can actually
//   accept, fill the new column for the rows that exist, and only then let the
//   normal `db push` contract to the final shape.
//
// Run: node scripts/check-schema-push-safety.mjs   (npm run check:schema-push)

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCHEMA_FILE = 'prisma/schema.prisma';

// ── Deliberate exclusions ────────────────────────────────────────────────────
// A change listed here is known to be refused by `db push` on a populated table
// and is being shipped anyway — because the author has established that the
// table is empty in EVERY environment that will receive the push (prod,
// preview, and every live topic env), or because a hand-written expand/backfill
// script in the same PR runs before the push. Every entry needs a written
// reason, so an intentional bypass is a code-review conversation and is
// distinguishable from a forgotten one.
//
// Keys are the finding keys this script prints, e.g. `Setting.id`, `Setting.@id`,
// `Setting.@unique(orgId, key)`.
//
// Unlike the EXEMPT map in check-tenant-models.mjs, an entry here is EPHEMERAL:
// it describes a diff, and the diff disappears the moment the PR merges and the
// merge-base moves forward. So a stale entry is a warning, never a failure —
// failing on it would turn every merged exemption into a red build for whoever
// opens the next PR. Delete the entry in the PR that follows.
export const EXEMPT = new Map([
  // ['Setting.id', 'table is empty in prod/preview — verified <date>, see #NNNN'],
]);

// Prisma's scalar types. A field whose base type is one of these — or one of
// the enums declared in the same file — is a real column; anything else is a
// relation field, which is virtual and adds no column of its own (the scalar
// in its `fields: [...]` list is the column, and that scalar is checked like
// any other).
const SCALARS = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
]);

// Defaults MySQL can resolve for rows that already exist, either because the
// value is a literal or because the server computes it during the ALTER.
const DB_RESOLVABLE_FUNCTIONS = new Set(['now', 'autoincrement', 'dbgenerated']);

// Defaults Prisma computes in the application, one row at a time, on write.
// There is no SQL expression for them, so an ALTER TABLE that adds a NOT NULL
// column with one of these has nothing to write into the existing rows.
const CLIENT_SIDE_FUNCTIONS = new Set(['cuid', 'uuid', 'ulid', 'nanoid', 'auto']);

// ── Parsing ──────────────────────────────────────────────────────────────────

// Strip a trailing line comment without touching a `//` that sits inside a
// string default (`@default("http://…")`).
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

// The argument text of `@default(...)`, read with a paren counter so a nested
// call (`dbgenerated("uuid()")`) survives intact.
function defaultExpression(attrs) {
  const at = attrs.indexOf('@default(');
  if (at < 0) return null;
  let depth = 0;
  let quote = null;
  for (let i = at + '@default'.length; i < attrs.length; i += 1) {
    const char = attrs[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return attrs.slice(at + '@default('.length, i).trim();
    }
  }
  return null;
}

// 'client' — Prisma generates it per row, so existing rows cannot be filled.
// 'db'     — a literal or a server-side expression MySQL applies to every row.
// Anything unrecognised is reported as 'client', which is the fail-closed
// answer: a default this script cannot classify is exactly the case where a
// human should look.
function classifyDefault(expression) {
  if (expression === null) return 'none';
  const call = expression.match(/^(\w+)\s*\(/);
  if (!call) return 'db'; // 0, "x", false, ACTIVE, [] — all literals.
  const fn = call[1];
  if (DB_RESOLVABLE_FUNCTIONS.has(fn)) return 'db';
  if (CLIENT_SIDE_FUNCTIONS.has(fn)) return 'client';
  return 'client';
}

const columnList = (raw) =>
  raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

// Prisma model bodies contain no nested braces, so a non-greedy match to a
// line-start `}` is exact — and `npx prisma validate` runs in CI ahead of this,
// so the file is guaranteed to be well-formed by the time we get here.
export function parseSchema(source) {
  const enums = new Set([...source.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1]));
  const models = new Map();

  for (const [, name, body] of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = new Map();
    const uniques = [];
    let idField = null;
    let blockId = null;

    for (const rawLine of body.split('\n')) {
      const line = stripComment(rawLine).trim();
      if (line === '') continue;

      if (line.startsWith('@@')) {
        const block = line.match(/^@@(\w+)\s*\(([\s\S]*)\)\s*$/);
        if (!block) continue;
        const [, kind, args] = block;
        const columns = columnList(args.match(/\[([^\]]*)\]/)?.[1] ?? '');
        if (kind === 'id') blockId = columns.join(', ');
        else if (kind === 'unique') uniques.push(columns);
        continue;
      }

      const field = line.match(/^(\w+)\s+(\S+)\s*(.*)$/);
      if (!field) continue;
      const [, fieldName, rawType, attrs] = field;
      const list = rawType.endsWith('[]');
      const optional = rawType.endsWith('?');
      const type = rawType.replace(/[?[\]]+$/, '');
      const isColumn =
        !list && !attrs.includes('@relation(') && (SCALARS.has(type) || enums.has(type));
      const expression = defaultExpression(attrs);

      if (attrs.includes('@id')) idField = fieldName;
      if (attrs.includes('@unique')) uniques.push([fieldName]);

      fields.set(fieldName, {
        name: fieldName,
        type: rawType,
        optional,
        isColumn,
        default: expression,
        defaultKind: classifyDefault(expression),
      });
    }

    // One value describing the primary key, so "moved from `key` to `id`",
    // "gained a composite key" and "lost its key" are all one comparison.
    const primaryKey = blockId !== null ? `@@id([${blockId}])` : idField !== null ? idField : null;
    models.set(name, { name, fields, uniques, primaryKey });
  }

  if (models.size === 0) throw new Error(`No models parsed out of ${SCHEMA_FILE}`);
  return { models, enums };
}

// ── The rules ────────────────────────────────────────────────────────────────

// Which worked example to point at. push-setting-id-expand.mjs is #2265's
// script for this exact failure; it is only named once it is actually in the
// tree, so the message never sends anyone after a file that does not exist.
function workedExamples() {
  const examples = [
    'prisma/push-company-interest-expand.mjs',
    'prisma/push-setting-id-expand.mjs',
  ].filter((file) => existsSync(file));
  if (examples.length === 0) return 'the expand/backfill/contract shape (see #2265)';
  return `${examples.join(' and ')} — the worked example${examples.length > 1 ? 's' : ''} of the expand/backfill/contract shape`;
}

export function analyzeSchemas(baseSource, headSource) {
  const base = parseSchema(baseSource);
  const head = parseSchema(headSource);
  const findings = [];
  const examples = workedExamples();

  for (const [name, headModel] of head.models) {
    const baseModel = base.models.get(name);
    // A model that is new in this diff has no rows anywhere, so every step that
    // creates it is legal. This is the single biggest source of would-be false
    // positives: every model in the tree carries `id String @id @default(cuid())`.
    if (!baseModel) continue;

    // 1 + 2. Required columns added to a table that already exists.
    for (const [fieldName, field] of headModel.fields) {
      if (baseModel.fields.has(fieldName)) continue;
      if (!field.isColumn || field.optional) continue;
      if (field.defaultKind === 'db') continue;

      const why =
        field.defaultKind === 'none'
          ? `it is NOT NULL with no default, so there is no value for the rows that are already in \`${name}\``
          : `\`@default(${field.default})\` is generated by Prisma in the application, not by MySQL, so the ALTER TABLE has no value for the rows that are already in \`${name}\``;

      findings.push({
        key: `${name}.${fieldName}`,
        level: 'error',
        message:
          `${name}.${fieldName} (${field.type}) is a new required column and \`prisma db push\` will ` +
          `REFUSE this step on a populated table: ${why}. The deploy stops with ` +
          '"it is not possible to execute this step" — `--accept-data-loss` does not cover it, ' +
          'because it is a cannot-execute, not a data-loss warning. Every PR topic env has its ' +
          'own empty database (#1185), which is why this looks harmless on the preview URL. ' +
          `Fix: add the column nullable, backfill it, then make it required — see ${examples}. ` +
          `Or make the default DB-resolvable (\`@default("")\`, \`@default(0)\`, \`@default(now())\`).`,
      });
    }

    // 3. Primary key changes: DROP + CREATE on a table with rows.
    if (baseModel.primaryKey !== headModel.primaryKey) {
      const from = baseModel.primaryKey ?? '(none)';
      const to = headModel.primaryKey ?? '(none)';
      findings.push({
        key: `${name}.@id`,
        level: 'error',
        message:
          `${name}'s primary key changes from \`${from}\` to \`${to}\`. Prisma resolves a primary-key ` +
          'change as DROP PRIMARY KEY + ADD PRIMARY KEY, which on a populated table is either ' +
          'refused outright or silently destructive (the #2249 shape: the new key column has a ' +
          'client-side default, so it cannot be created NOT NULL over existing rows). ' +
          `Fix: expand → backfill → contract in a script that runs before the push — see ${examples}.`,
      });
    }

    // 4. A unique constraint over columns that already hold data.
    const baseUniques = new Set(baseModel.uniques.map((cols) => cols.join(', ')));
    for (const cols of headModel.uniques) {
      const signature = cols.join(', ');
      if (baseUniques.has(signature)) continue;
      if (!cols.every((col) => baseModel.fields.has(col))) continue;
      findings.push({
        key: `${name}.@unique(${signature})`,
        level: 'warning',
        message:
          `${name} gains a unique constraint on (${signature}), and every one of those columns ` +
          'already exists — so the live tables may already hold duplicate rows, in which case ' +
          '`db push` fails on the index creation. Nothing here can tell: check the data (or ' +
          'de-duplicate first) before merging.',
      });
    }
  }

  return findings;
}

// ── Resolving the merge-base ─────────────────────────────────────────────────

function git(args) {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  if (run.error || run.status !== 0) return null;
  return run.stdout;
}

// The base is the merge-base with the branch this change is going to land on.
// A shallow clone may not have it — and "no base" must never mean "clean", so
// every failure here exits non-zero with the fix in the message.
export function resolveBase(env = process.env) {
  const candidates = [
    env.SCHEMA_PUSH_SAFETY_BASE,
    env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : null,
    'origin/main',
    'main',
  ].filter(Boolean);

  const tried = [];
  for (const ref of candidates) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) === null) {
      tried.push(`${ref} (no such ref)`);
      continue;
    }
    const mergeBase = git(['merge-base', 'HEAD', ref])?.trim();
    if (!mergeBase) {
      tried.push(`${ref} (no merge-base with HEAD — shallow clone?)`);
      continue;
    }
    return { ref, sha: mergeBase };
  }
  return { error: tried };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  if (git(['rev-parse', '--git-dir']) === null) {
    console.error(
      'schema push safety FAILED — not a git repository, so the schema cannot be compared ' +
        'against its merge-base. This check fails closed on purpose: "no base" must never be ' +
        'reported as "no problem".',
    );
    process.exit(1);
  }

  const base = resolveBase();
  if (base.error) {
    console.error('schema push safety FAILED — could not resolve a base revision to diff against:');
    for (const attempt of base.error) console.error(`  • tried ${attempt}`);
    console.error(
      '\nThis check fails closed: a schema change that `prisma db push` cannot apply to a ' +
        'populated table would otherwise sail through unexamined. In CI, check out with ' +
        '`fetch-depth: 0` (a shallow clone has no merge-base); locally, run ' +
        '`git fetch origin main`, or point the check at a revision yourself with ' +
        'SCHEMA_PUSH_SAFETY_BASE=<ref>.',
    );
    process.exit(1);
  }

  const baseSource = git(['show', `${base.sha}:${SCHEMA_FILE}`]);
  if (baseSource === null) {
    console.error(
      `schema push safety FAILED — could not read ${SCHEMA_FILE} at ${base.sha.slice(0, 8)} ` +
        `(merge-base with ${base.ref}). Fetch more history, or set SCHEMA_PUSH_SAFETY_BASE.`,
    );
    process.exit(1);
  }

  // The working tree, not HEAD: an uncommitted schema edit is exactly the
  // moment this is most useful to its author.
  const headSource = readFileSync(SCHEMA_FILE, 'utf8');
  const shortBase = `${base.ref} (${base.sha.slice(0, 8)})`;

  if (baseSource === headSource) {
    console.log(`schema push safety OK — ${SCHEMA_FILE} is unchanged since ${shortBase}.`);
    return;
  }

  const findings = analyzeSchemas(baseSource, headSource);
  const active = findings.filter((f) => !EXEMPT.has(f.key));
  const errors = active.filter((f) => f.level === 'error');
  const warnings = active.filter((f) => f.level === 'warning');
  const exempted = findings.filter((f) => EXEMPT.has(f.key));

  if (errors.length > 0) {
    console.error(
      'schema push safety FAILED — this schema diff contains a step `prisma db push` cannot ' +
        'apply to a table that already has rows:\n',
    );
    for (const finding of errors) console.error(`  • ${finding.message}\n`);
    console.error(
      'This is the #2249 failure class: additive in the schema, legal against the empty ' +
        'database of a topic env, and refused on the first environment with data — which stalled ' +
        'every prod and preview deploy for 13 commits.\n' +
        'If the table really is empty in every environment that will receive this push, add the ' +
        `finding key to EXEMPT in scripts/check-schema-push-safety.mjs with the reason:\n${errors
          .map((f) => `      ['${f.key}', '<why this is safe>'],`)
          .join('\n')}`,
    );
    process.exit(1);
  }

  if (warnings.length > 0) {
    const headline = `${warnings.length} schema change(s) may fail on the live data:`;
    const lines = warnings.map((f) => `  • ${f.message}`);
    if (process.env.GITHUB_ACTIONS) {
      console.log(
        `::warning file=${SCHEMA_FILE},title=Schema change depends on the live data::${[
          headline,
          ...lines,
        ]
          .join('%0A')
          .replace(/\r?\n/g, ' ')}`,
      );
    }
    console.warn(`schema push safety: ${headline}`);
    for (const line of lines) console.warn(line);
  }

  for (const finding of exempted) {
    console.warn(
      `schema push safety: ${finding.key} is EXEMPT in this script — ${EXEMPT.get(finding.key)}`,
    );
  }

  const stale = [...EXEMPT.keys()].filter((key) => !findings.some((f) => f.key === key));
  if (stale.length > 0) {
    // Not a failure: an exemption describes a diff, and the diff is gone as
    // soon as the merge-base moves past it. Failing here would hand the next
    // PR a red build for someone else's merged change.
    console.warn(
      `schema push safety: EXEMPT names ${stale.join(', ')}, which this diff no longer contains — ` +
        'the change has landed, so the entry can be deleted.',
    );
  }

  const compared = parseSchema(headSource).models.size;
  console.log(
    `schema push safety OK — ${compared} model(s) compared against ${shortBase}; no new required ` +
      'column with a client-side or absent default, and no primary-key change, on a model that ' +
      `already exists${warnings.length > 0 ? ` (${warnings.length} warning(s) above)` : ''}.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
