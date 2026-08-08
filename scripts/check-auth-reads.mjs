#!/usr/bin/env node
// Guard: the authentication path must never hydrate a whole User row.
//
// Prisma JSON.parse()s a `Json` column on read, so a single row holding an
// invalid value ('' instead of '[]') makes the read throw. When sign-in read
// every column it did not need, one such row locked that account out of the
// product entirely and printed "Unexpected end of JSON input" on the login form
// (#1150). The fix was to `select` only the columns sign-in actually uses; this
// check keeps it that way — the next unqualified `prisma.user.findUnique(...)`
// in the auth path fails CI instead of production.
//
// Run: node scripts/check-auth-reads.mjs   (npm run check:auth-reads)

import { readFileSync } from 'node:fs';

// Overridable so the guard itself can be exercised against a fixture.
const FILE = process.argv[2] || 'src/lib/auth.ts';
// Reads/writes on User in this module must all be column-scoped. Grant lookups
// (impersonationGrant, ssoLoginGrant) carry no Json columns and are exempt.
const GUARDED = ['prisma.user.findUnique(', 'prisma.user.findFirst(', 'prisma.user.update('];
// Never widen the auth select to a Json column: that would re-open the hole.
const JSON_COLUMNS = ['skills', 'languages', 'skillLevels', 'notificationPrefs'];

const source = readFileSync(FILE, 'utf8');
const problems = [];

const lineOf = (index) => source.slice(0, index).split('\n').length;

// Walk from the call's opening paren to its match so nested objects/arrays in
// the argument can't confuse the check.
function callArguments(from) {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return source.slice(from);
}

for (const call of GUARDED) {
  let at = source.indexOf(call);
  while (at !== -1) {
    const args = callArguments(at + call.length - 1);
    if (!/\bselect\s*:/.test(args)) {
      problems.push(
        `${FILE}:${lineOf(at)}  ${call.replace('prisma.user.', 'prisma.user.').replace('(', '')} has no \`select:\` — ` +
          'it hydrates every User column, including the Json ones. Use AUTH_USER_SELECT (or a narrower select).'
      );
    }
    for (const column of JSON_COLUMNS) {
      if (new RegExp(`\\b${column}\\s*:\\s*true\\b`).test(args)) {
        problems.push(
          `${FILE}:${lineOf(at)}  selects the Json column \`${column}\` — the auth path must not read Json columns.`
        );
      }
    }
    at = source.indexOf(call, at + 1);
  }
}

if (problems.length > 0) {
  console.error('auth reads FAILED — authentication must not depend on columns it does not use:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error(`\nSee the AUTH_USER_SELECT comment in ${FILE}.`);
  process.exit(1);
}

const guarded = GUARDED.reduce((n, call) => n + source.split(call).length - 1, 0);
console.log(`auth reads OK — ${guarded} User query/queries in ${FILE}, all column-scoped, no Json columns.`);
