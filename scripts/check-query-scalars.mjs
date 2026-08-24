#!/usr/bin/env node
// Guard: an unvalidated request body must never reach a Prisma `where` clause.
//
// Why this exists. A SAST sweep (2026-08) reported "NoSQL injection possible"
// as Critical on ~a dozen `prisma.x.update({ where: { id } })` call sites. There
// is no NoSQL store here — it is MySQL behind Prisma, which sends every value
// as a bound parameter, so no value can ever be parsed as query syntax. Every
// flagged site was a false positive (the audit is written up in
// docs/security-audit-playbook.md § Prisma query construction).
//
// But the *adjacent* bug is real, and it is the one worth a guard. Prisma's
// filter grammar is data: a `where` value that arrives as an OBJECT rather than
// a scalar is read as a filter operator, so
//
//     { "id": { "not": "someone-elses-id" } }
//
// POSTed into a handler that does `where: { id: body.id }` silently converts an
// equality lookup into "every row except that one" — an authorization bypass
// wearing the shape of a normal query. Prisma's TypeScript types forbid it, but
// types are erased at runtime and `request.json()` returns `any`: nothing but
// a runtime check stands between a JSON body and that filter.
//
// The codebase is clean today — every id reaching a `where` is a route param
// (always a string), a session/DB-derived id, or a zod/`typeof`-validated field.
// This check is what keeps that true: the next handler that pipes a raw body
// field into a filter fails CI instead of shipping.
//
// Run: node scripts/check-query-scalars.mjs   (npm run check:query-scalars)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Overridable so the guard itself can be exercised against a fixture.
const ROOTS = process.argv.length > 2 ? process.argv.slice(2) : ['src'];

function sourceFiles(paths) {
  const out = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) walk(join(p, entry));
    } else if (/\.tsx?$/.test(p)) {
      out.push(p);
    }
  };
  for (const p of paths) walk(p);
  return out;
}

// `const body = await request.json()`, `const { id } = await req.json()`,
// and the `.catch(() => ({}))` spelling this repo uses on optional bodies.
const RAW_BODY_BINDING = /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:request|req)\.json\(\)/g;
// `const target = body.referredById || null` — one hop off a raw body.
const aliasOf = (name) =>
  new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${name}\\.[\\w$]+`, 'g');

// Walk from an opening brace to its match so nested filters (`OR: [{ ... }]`)
// are captured whole rather than cut at the first `}`.
function balanced(source, open) {
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const close = pairs[source[open]];
  if (!close) return '';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === source[open]) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

// Every `where:` argument in the file, as {text, index} regions.
function whereRegions(source) {
  const regions = [];
  const re = /\bwhere\s*:\s*/g;
  let m;
  while ((m = re.exec(source))) {
    const at = m.index + m[0].length;
    if (source[at] === '{') regions.push({ text: balanced(source, at), index: m.index });
    // `where: someVar` — take the bare expression up to the next separator.
    else regions.push({ text: source.slice(at, at + 200).split(/[,\n]/)[0], index: m.index });
  }
  return regions;
}

// A runtime narrowing that makes the symbol provably a scalar. Both polarities
// count: `typeof x === 'string'` guarding the use, and the early-return form
// `if (typeof x !== 'string') return` that guards everything after it. `String(x)`
// and a zod parse of the same symbol count too.
function hasScalarGuard(source, symbol) {
  const s = symbol.replace(/[.$]/g, '\\$&');
  return (
    new RegExp(`typeof\\s+${s}\\s*[!=]==?\\s*['"](?:string|number)['"]`).test(source) ||
    new RegExp(`String\\(\\s*${s}\\s*\\)`).test(source) ||
    new RegExp(`safeParse\\(\\s*${s}\\s*\\)`).test(source) ||
    new RegExp(`\\.parse\\(\\s*${s}\\s*\\)`).test(source)
  );
}

// Every concrete way the symbol is used as a VALUE inside a where region:
// `id: body.id`, the `{ id }` shorthand, or an `in: [ids]` list. Returns the
// matched EXPRESSIONS (`body.id`, not `body`) because that is what a runtime
// guard is written against — `typeof body.id === 'string'`, never `typeof body`.
function valueUsages(region, symbol) {
  const s = symbol.replace(/[.$]/g, '\\$&');
  // A container symbol is only interesting through a property access; a symbol
  // that is already a member expression is used as-is.
  const expr = /\./.test(symbol) ? s : `${s}(?:\\.[\\w$]+)?`;
  const found = new Set();
  for (const re of [
    new RegExp(`:\\s*(${expr})\\b`, 'g'),
    new RegExp(`[{[,]\\s*(${expr})\\s*[,}\\]]`, 'g'),
  ]) {
    let m;
    while ((m = re.exec(region))) found.add(m[1]);
  }
  return [...found];
}

const problems = [];
let scanned = 0;
let rawBodyFiles = 0;
let regionCount = 0;

for (const file of sourceFiles(ROOTS)) {
  const source = readFileSync(file, 'utf8');
  if (!/\.json\(\)/.test(source) || !/\bwhere\s*:/.test(source)) continue;
  scanned++;
  const lineOf = (index) => source.slice(0, index).split('\n').length;

  // Collect the symbols that carry an unvalidated body.
  const tainted = new Set();
  // alias → the `body.field` expression it was read from.
  const origin = new Map();
  RAW_BODY_BINDING.lastIndex = 0;
  let m;
  while ((m = RAW_BODY_BINDING.exec(source))) {
    const binding = m[1];
    if (binding.startsWith('{')) {
      // Destructured straight off the body: each name is raw.
      for (const part of binding.slice(1, -1).split(',')) {
        const name = part.split(':')[0].split('=')[0].trim();
        if (name && !name.startsWith('...')) tainted.add(name);
      }
    } else {
      tainted.add(binding);
      // One hop: `const x = body.y`. Remember where it came from — the runtime
      // guard is usually written on the source expression (`typeof body.y ===
      // 'string'`), not on the alias, and it narrows both.
      const alias = aliasOf(binding);
      let a;
      while ((a = alias.exec(source))) {
        tainted.add(a[1]);
        origin.set(a[1], a[0].slice(a[0].indexOf('=') + 1).trim());
      }
    }
  }
  if (tainted.size === 0) continue;

  rawBodyFiles++;
  const regions = whereRegions(source);
  regionCount += regions.length;

  for (const region of regions) {
    for (const symbol of tainted) {
      for (const usage of valueUsages(region.text, symbol)) {
        // A guard on the expression that actually reaches the filter, on the
        // bare symbol, or on the `body.field` an alias was read from — any of
        // the three proves it is a scalar by the time it gets here.
        if (hasScalarGuard(source, usage)) continue;
        if (hasScalarGuard(source, symbol)) continue;
        const from = origin.get(symbol);
        if (from && hasScalarGuard(source, from)) continue;
        problems.push(
          `${file}:${lineOf(region.index)}  \`${usage}\` comes straight off request.json() and is ` +
            'used as a `where` value. A JSON object there is read as a Prisma filter operator ' +
            '(e.g. {"not": "..."}), which turns the lookup into a different query. Validate it ' +
            'with zod (`z.string()`) or a `typeof === \'string\'` check first.'
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error('query scalars FAILED — a raw request body must not become a Prisma filter:\n');
  for (const problem of [...new Set(problems)]) console.error(`  • ${problem}`);
  console.error('\nSee docs/security-audit-playbook.md § Prisma query construction.');
  process.exit(1);
}

console.log(
  `query scalars OK — ${scanned} file(s) build a \`where\` from a request body; ` +
    `${regionCount} \`where\` clause(s) in the ${rawBodyFiles} that bind the body unvalidated ` +
    'were checked, and none pipes an unvalidated value into a filter.'
);
