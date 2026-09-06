#!/usr/bin/env node
// Guard: a user-visible date or time must never be formatted without a locale.
//
// Why this exists. `toLocaleDateString()` / `toLocaleTimeString()` /
// `toLocaleString()` with no arguments do not use the app's language — they use
// the *browser's*. A visitor whose machine is set to `en-US` therefore read
// "8/25/2026" on a screen that was otherwise entirely in Turkish (#1422), and a
// proposed interview slot printed on the browser's clock with no zone named at
// all, which is how an admin in Berlin books 16:30 against a company that meant
// 16:30 in Istanbul.
//
// The repo has had the answer since #1030: `formatDate` / `formatDateTime` /
// `formatTime` / `formatDateTimeWithZone` in src/lib/relativeTime.ts all take
// the app locale, and the last one also names the zone. Four call sites simply
// never got the memo — and a fifth would have landed next week, which is what
// this check is for. It is deliberately narrow: it does not care *which* locale
// you pass, only that you passed one, because "the browser decides" is the one
// answer that is always wrong here.
//
// Run: node scripts/check-locale-dates.mjs   (npm run check:locale-dates)

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
    } else if (/\.[cm]?[jt]sx?$/.test(p)) {
      out.push(p);
    }
  };
  for (const p of paths) walk(p);
  return out;
}

// Blank out comments and string/template literals, preserving newlines and
// length so reported line numbers still point at the real source. Without this
// the header of src/lib/timezone.ts — which *quotes* the bug it fixed — reports
// itself, and the guard cries wolf on the one file that documents the rule.
function stripNonCode(source) {
  let out = '';
  let i = 0;
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') j += 2;
        else if (source[j] === quote) { j++; break; }
        else j++;
      }
      // Keep the quotes so the surrounding expression still parses visually;
      // blank the contents.
      out += quote + blank(source.slice(i + 1, Math.max(i + 1, j - 1))) + (j <= source.length ? quote : '');
      i = j;
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

// `.toLocaleDateString()`, `.toLocaleString(undefined, …)` and friends — the
// forms that hand the decision to the browser. Anything with a real first
// argument (a locale string, a variable, `locale`) passes.
const BARE_CALL = /\.toLocale(?:Date|Time)?String\s*\(\s*(?:\)|undefined\b)/g;

const problems = [];
let scanned = 0;
let callSites = 0;

for (const file of sourceFiles(ROOTS)) {
  const raw = readFileSync(file, 'utf8');
  if (!raw.includes('toLocale')) continue;
  scanned++;
  const source = stripNonCode(raw);
  BARE_CALL.lastIndex = 0;
  let m;
  while ((m = BARE_CALL.exec(source))) {
    callSites++;
    const line = source.slice(0, m.index).split('\n').length;
    const method = /toLocale(?:Date|Time)?String/.exec(m[0])[0];
    problems.push(
      `${file}:${line}  \`${method}()\` with no locale — this renders in the BROWSER's language, ` +
        "not the app's, so a Turkish UI on a US-locale machine prints 8/25/2026. Use " +
        'formatDate / formatDateTime / formatTime from src/lib/relativeTime.ts and pass the app ' +
        'locale (`useLocale()` in a client component). For a meeting or interview time use ' +
        'formatDateTimeWithZone, which also names the zone (#1030, #1422).'
    );
  }
}

if (problems.length > 0) {
  console.error('locale dates FAILED — a displayed date must follow the app language, not the browser:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error(`\n${problems.length} call site(s). See src/lib/relativeTime.ts and issue #1422.`);
  process.exit(1);
}

console.log(
  `locale dates OK — ${scanned} file(s) mention toLocale*; ${callSites} locale-less call site(s) found. ` +
    'Every displayed date/time goes through the app-locale helpers in src/lib/relativeTime.ts.'
);
