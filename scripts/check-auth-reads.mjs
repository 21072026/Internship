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

// Every file on the way in: sign-in itself, plus the two routes a locked-out
// user reaches for. `forgot` matters as much as `auth.ts` — it answers a generic
// "ok: true" whether or not the mail went out, so a throw in there is invisible
// and the reset link simply never arrives.
// Overridable so the guard itself can be exercised against a fixture.
const FILES =
  process.argv.length > 2
    ? process.argv.slice(2)
    : [
        'src/lib/auth.ts',
        'src/app/api/auth/forgot/route.ts',
        'src/app/api/auth/verify-email/resend/route.ts',
      ];
// Reads/writes on User in these modules must all be column-scoped. Grant lookups
// (impersonationGrant, ssoLoginGrant) carry no Json columns and are exempt.
const GUARDED = ['prisma.user.findUnique(', 'prisma.user.findFirst(', 'prisma.user.update('];
// Never widen one of these selects to a Json column: that would re-open the hole.
const JSON_COLUMNS = ['skills', 'languages', 'skillLevels', 'notificationPrefs'];

const problems = [];
let checked = 0;

// Walk from the call's opening paren to its match so nested objects/arrays in
// the argument can't confuse the check.
function callArguments(source, from) {
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

for (const file of FILES) {
  const source = readFileSync(file, 'utf8');
  const lineOf = (index) => source.slice(0, index).split('\n').length;

  for (const call of GUARDED) {
    let at = source.indexOf(call);
    while (at !== -1) {
      checked++;
      const args = callArguments(source, at + call.length - 1);
      if (!/\bselect\s*:/.test(args)) {
        problems.push(
          `${file}:${lineOf(at)}  ${call.replace('(', '')} has no \`select:\` — it hydrates every ` +
            'User column, including the Json ones. Use AUTH_USER_SELECT (or a narrower select).'
        );
      }
      for (const column of JSON_COLUMNS) {
        if (new RegExp(`\\b${column}\\s*:\\s*true\\b`).test(args)) {
          problems.push(
            `${file}:${lineOf(at)}  selects the Json column \`${column}\` — the way in must not read Json columns.`
          );
        }
      }
      at = source.indexOf(call, at + 1);
    }
  }
}

if (problems.length > 0) {
  console.error('auth reads FAILED — getting in must not depend on columns it does not use:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('\nSee the AUTH_USER_SELECT comment in src/lib/auth.ts.');
  process.exit(1);
}

console.log(
  `auth reads OK — ${checked} User query/queries across ${FILES.length} file(s), ` +
    'all column-scoped, no Json columns.'
);
