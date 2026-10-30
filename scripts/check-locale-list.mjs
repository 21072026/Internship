#!/usr/bin/env node
// Guard: the list of locales is written ONCE, in src/i18n/config.ts (#2082).
//
// WHY THIS EXISTS
//   Adding a fourth language means adding it to `locales` in config.ts — and
//   then finding every other place that spelled the list out by hand. A
//   `z.enum(['en', 'tr', 'de'])` on a route compiles, passes every test, and
//   then silently refuses the new language: a French reader could not save
//   `preferredLanguage` at all. A `Record<'en' | 'tr' | 'de', …>` is the same
//   blind spot for the type checker, which would otherwise list it for us.
//   Code reads `locales` / `Locale` / `isLocale()` from config.ts instead.
//
// WHAT IT CHECKS
//   Every tracked .ts/.tsx under src/ is searched for a hand-written locale
//   list: the array `['en', 'tr', 'de']` or the union `'en' | 'tr' | 'de'`
//   (either quote style). The sites written before this guard are pinned per
//   file in scripts/locale-list-baseline.json: a new one fails, and so does a
//   file that has fewer than pinned until its entry is lowered — run
//   `npm run check:locale-list -- --shrink` — so the number only goes down.
//
// Run: npm run check:locale-list
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const BASELINE = 'scripts/locale-list-baseline.json';
const HOME = 'src/i18n/config.ts';

const Q = `['"]`;
const LIST = new RegExp(
  [
    `\\[\\s*${Q}en${Q}\\s*,\\s*${Q}tr${Q}\\s*,\\s*${Q}de${Q}\\s*,?\\s*\\]`,
    `${Q}en${Q}\\s*\\|\\s*${Q}tr${Q}\\s*\\|\\s*${Q}de${Q}`,
  ].join('|'),
  'g',
);

export function countLocaleLists(text) {
  // Comments do not ship: a sentence that quotes the list is not a list.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  return (code.match(LIST) ?? []).length;
}

function scan() {
  const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f) && f !== HOME);
  const found = {};
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const n = countLocaleLists(text);
    if (n > 0) found[f] = n;
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = scan();
  const doc = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const pinned = doc.pending ?? {};
  if (process.argv.includes('--shrink')) {
    const next = {};
    for (const [f, n] of Object.entries(pinned)) {
      const have = found[f] ?? 0;
      if (have > 0) next[f] = Math.min(n, have);
    }
    writeFileSync(BASELINE, `${JSON.stringify({ ...doc, pending: next }, null, 2)}\n`);
    console.log(`locale-list baseline shrunk: ${Object.values(pinned).reduce((a, b) => a + b, 0)} → ${Object.values(next).reduce((a, b) => a + b, 0)}`);
    process.exit(0);
  }
  const problems = [];
  for (const [f, n] of Object.entries(found)) {
    const budget = pinned[f] ?? 0;
    if (n > budget) {
      problems.push(
        `${f}: ${n} hand-written locale list(s), the baseline allows ${budget}. Import \`locales\` / \`Locale\` / \`isLocale\` from @/i18n/config instead — a copy of the list silently leaves out the next language.`,
      );
    }
  }
  for (const [f, n] of Object.entries(pinned)) {
    const have = found[f] ?? 0;
    if (have < n) problems.push(`${f}: only ${have} hand-written locale list(s) left, pinned ${n} — run npm run check:locale-list -- --shrink in this diff.`);
  }
  if (problems.length) {
    console.error(`check:locale-list failed:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  const total = Object.values(found).reduce((a, b) => a + b, 0);
  console.log(`locale list OK — written once in ${HOME}; ${total} older copy/copies in ${Object.keys(found).length} file(s) pinned, none new; the baseline only shrinks.`);
}
