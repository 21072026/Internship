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

// Blank out COMMENTS — and only comments — preserving newlines and length so
// reported line numbers still point at the real source. Comment stripping is
// the part that actually needs doing: the header of src/lib/timezone.ts *quotes*
// the bug it fixed, and without this the guard cries wolf on the one file that
// documents the rule.
//
// String and template literals are deliberately kept. An earlier version blanked
// them too and went blind twice over:
//   • `` `saved ${d.toLocaleTimeString()}` `` — the offending call sits inside a
//     template *interpolation*, which is code, not text, and is the single most
//     idiomatic shape for this bug (the site this check was written for was one
//     `.replace('{t}', …)` refactor away from it);
//   • `<p>Don't panic: {d.toLocaleDateString()}</p>` — a bare apostrophe in JSX
//     text opened a "string" that swallowed the rest of the file.
// Keeping the contents costs only the reverse risk — a `.toLocaleDateString()`
// written inside an actual string would be reported — and that failure is loud
// and one comment away from a fix, where a missed call site is silent forever.
//
// The quote scanner is still needed so that a `//` inside a string ("https://…")
// is not mistaken for a comment. Two details keep a mis-lex cheap: a quoted JS
// string cannot contain a raw newline, so a stray apostrophe can only ever
// mislead the scanner to the end of its own line; and a template literal is
// copied verbatim through to its closing backtick, so nothing inside one can
// look like a comment.
function stripComments(source) {
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
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== '\n') {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === quote) { j++; break; }
        j++;
      }
      out += source.slice(i, j); // kept verbatim, contents and all
      i = j;
    } else if (source[i] === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '`') { j++; break; }
        j++;
      }
      out += source.slice(i, j);
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

// Every locale-less call in one source, as { line, method }.
function bareCalls(raw) {
  const source = stripComments(raw);
  const found = [];
  BARE_CALL.lastIndex = 0;
  let m;
  while ((m = BARE_CALL.exec(source))) {
    found.push({
      line: source.slice(0, m.index).split('\n').length,
      method: /toLocale(?:Date|Time)?String/.exec(m[0])[0],
    });
  }
  return found;
}

// The guard checks itself before it checks the tree. Every case below is one
// this script has actually got wrong, so a future "simplification" of
// stripComments fails here rather than by quietly passing a real call site.
const SELF_TESTS = [
  ['a bare call in JSX', 'const a = <p>{d.toLocaleDateString()}</p>;', 1],
  ['inside a template interpolation', 'const a = <p>{`saved ${d.toLocaleTimeString()}`}</p>;', 1],
  ["after an apostrophe in JSX text", "const a = <p>Don't panic: {d.toLocaleDateString()}</p>;", 1],
  ['undefined as the locale', 'const a = d.toLocaleString(undefined, { hour: "2-digit" });', 1],
  ['two on separate lines', 'const a = d.toLocaleDateString();\nconst b = d.toLocaleTimeString();', 2],
  ['a locale was passed', "const a = d.toLocaleDateString(locale);", 0],
  ['a literal locale was passed', "const a = d.toLocaleDateString('tr', opts);", 0],
  ['a line comment quoting the bug', '// never write d.toLocaleDateString() here\nconst a = 1;', 0],
  ['a block comment quoting the bug', '/*\n * d.toLocaleDateString() is the bug.\n */\nconst a = 1;', 0],
  ['a URL in a string is not a comment', "const u = 'https://x/y'; const a = d.toLocaleDateString();", 1],
];

const selfFailures = SELF_TESTS.filter(([, code, want]) => bareCalls(code).length !== want);
if (selfFailures.length > 0) {
  console.error('locale dates guard is BROKEN — its own self-test failed, so its verdict on src means nothing:\n');
  for (const [name, code, want] of selfFailures) {
    console.error(`  • ${name}: expected ${want} hit(s), got ${bareCalls(code).length}\n      ${code.replace(/\n/g, '\\n')}`);
  }
  console.error('\nSee stripComments() in this file and issue #1422.');
  process.exit(1);
}

const problems = [];
let scanned = 0;

for (const file of sourceFiles(ROOTS)) {
  const raw = readFileSync(file, 'utf8');
  if (!raw.includes('toLocale')) continue;
  scanned++;
  for (const { line, method } of bareCalls(raw)) {
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
  `locale dates OK — self-test green (${SELF_TESTS.length} cases); ${scanned} file(s) mention toLocale*, ` +
    'none of them locale-less. Every displayed date/time goes through the app-locale helpers in ' +
    'src/lib/relativeTime.ts.'
);
