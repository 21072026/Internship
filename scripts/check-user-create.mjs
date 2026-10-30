#!/usr/bin/env node
// Guard: a User row has ONE writer (#1998), createUser() in src/lib/userCreate.ts.
//
// Every path that makes an account goes through it, so `user.created` fires on
// all of them or none — an event raised on some paths and not others is the
// trap #1998 warns about. A bare `<client>.user.create(`, `.createMany(` or
// `.upsert(` anywhere else under src/ is red. Seeds and one-off scripts in
// prisma/ and scripts/ are plain Node (they cannot import TS) and are not
// scanned: they write demo data, not a product event.
//
// A text scan: a call through an alias is invisible — that is what review is for.
// Run: node scripts/check-user-create.mjs   (npm run check:user-create)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOME = 'src/lib/userCreate.ts';
const CALL = /\.user\.(create|createMany|upsert)\s*\(/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const problems = [];
for (const file of walk('src')) {
  if (file === HOME) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (CALL.test(code)) problems.push(`${file}:${i + 1}  ${line.trim()}`);
    CALL.lastIndex = 0;
  });
}

if (problems.length) {
  console.error('user-create FAILED — a User row is written outside createUser() (src/lib/userCreate.ts, #1998):\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nCall createUser(db, args, { source }) instead, so user.created fires on every path.');
  process.exit(1);
}
console.log(`user-create OK — every User row goes through createUser() (${HOME}).`);
