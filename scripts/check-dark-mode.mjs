#!/usr/bin/env node
// Guard: a light surface ships with its dark mode (#1614).
//
// Why this exists. Dark mode is class-based (`html.dark`) and mostly handled by
// a flat retint layer in src/app/globals.css: `html.dark .bg-white`,
// `.bg-gray-50`, the soft `*-50` accent boxes and so on are remapped once, for
// every component. That layer covers a FIXED list of utilities. A component that
// paints a light surface with a utility outside the list — `bg-gray-200`,
// `bg-slate-50`, `bg-teal-50`, `hover:bg-gray-200`, `bg-white/90` — and writes
// no `dark:` background of its own stays a light box on a dark page, and nothing
// in CI notices: the axe scan measures nine pages, and each contrast bug so far
// got its own bespoke spec after somebody saw it.
//
// What it flags, from the TypeScript AST of every .tsx under src/app and
// src/components (a real parser, never a JSX regex): a `className` attribute
// whose string pieces carry a LIGHT background utility (below) that
//   · the retint layer does not cover (read from globals.css itself, so a new
//     `html.dark .bg-…` rule there clears its findings with no edit here), and
//   · is not answered on the same element by any `dark:` background utility
//     (`dark:bg-…`, `dark:!bg-…`, `dark:hover:bg-…`). A `dark:!` pin is how an
//     element deliberately keeps a light colour (CLAUDE.md, Dark mode), so it
//     passes by construction — there is no separate allowlist to maintain.
// Every string literal and template piece inside the attribute counts as one
// element, so `className={cn('bg-white', open && 'dark:bg-gray-800')}` passes.
//
// Deliberately NOT flagged: `bg-*-100` accent chips. They stay light on purpose
// (dark text on a light chip reads in both themes — CLAUDE.md, Dark mode).
//
// A RATCHET, not a sweep — the same discipline as check:hardcoded-strings: the
// per-file counts are pinned in scripts/dark-mode-baseline.json and the check
// fails BOTH ways (more findings than pinned, or fewer without lowering the pin
// in the same diff). `--write-baseline` rewrites the counts; use it to LOWER
// them.
//
// This is a FLOOR: classes built outside a className attribute (a constant
// map, a .ts helper) are invisible to it, and it says nothing about text
// contrast — the a11y scan and check:contrast do that.
//
// Run: node scripts/check-dark-mode.mjs   (npm run check:dark-mode)

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const DIRS = ['src/app', 'src/components'];
const BASELINE_FILE = 'scripts/dark-mode-baseline.json';
const GLOBALS_CSS = 'src/app/globals.css';

const ACCENTS = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const VARIANT = '(?:(?:hover|focus|focus-visible|focus-within|active|group-hover|peer-checked|odd|even|disabled):)*';
// White, the pale neutrals and the palest accent wash. An opacity suffix of 50
// or more still paints a light surface; a thinner one (`hover:bg-white/10` on a
// coloured hero) is a highlight that reads in both themes, and is not flagged.
const LIGHT_BG = new RegExp(
  `^${VARIANT}bg-(?:white|(?:gray|slate|zinc|neutral|stone)-(?:50|100|200|300)|(?:${ACCENTS})-50)(?:\\/(?:[5-9]\\d|100))?$`
);
const DARK_BG = /^dark:(?:[a-z-]+:)*!?bg-/;

/** The utilities globals.css retints under html.dark, as written in a className. */
export function retintedUtilities(css) {
  const covered = new Set();
  // `html.dark .hover\:bg-blue-50:hover {` → `hover:bg-blue-50`. A compound
  // (`.bg-gray-100.text-gray-600`) is only a partial remap and does not count.
  const re = /html\.dark \.((?:[A-Za-z0-9_-]|\\.)+)(?=[\s{,>:])/g;
  for (const m of css.matchAll(re)) covered.add(m[1].replace(/\\(.)/g, '$1'));
  return covered;
}

/** The findings of one className's token list. */
export function lightSurfacesWithoutDark(tokens, covered) {
  if (tokens.some((t) => DARK_BG.test(t))) return [];
  return tokens.filter((t) => LIGHT_BG.test(t) && !covered.has(t));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function stringPieces(node, out = []) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
  else if (ts.isTemplateExpression(node)) {
    out.push(node.head.text);
    for (const span of node.templateSpans) out.push(span.literal.text);
  }
  // A block body on purpose: forEachChild stops at the first truthy return.
  ts.forEachChild(node, (child) => {
    stringPieces(child, out);
  });
  return out;
}

export function scanSource(file, text, covered) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'className' && node.initializer) {
      const tokens = stringPieces(node.initializer).join(' ').split(/\s+/).filter(Boolean);
      for (const utility of lightSurfacesWithoutDark(tokens, covered)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        findings.push({ line: line + 1, utility });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function main() {
  const covered = retintedUtilities(readFileSync(join(ROOT, GLOBALS_CSS), 'utf8'));
  const byFile = {};
  for (const dir of DIRS) {
    for (const abs of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, abs);
      const findings = scanSource(rel, readFileSync(abs, 'utf8'), covered);
      if (findings.length) byFile[rel] = findings;
    }
  }
  const counts = Object.fromEntries(Object.entries(byFile).map(([f, list]) => [f, list.length]).sort(([a], [b]) => a.localeCompare(b)));

  if (process.argv.includes('--write-baseline')) {
    writeFileSync(join(ROOT, BASELINE_FILE), `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`dark mode: baseline written — ${Object.values(counts).reduce((a, b) => a + b, 0)} finding(s) in ${Object.keys(counts).length} file(s).`);
    return;
  }

  const baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_FILE), 'utf8'));
  const errors = [];
  for (const [file, list] of Object.entries(byFile)) {
    const pinned = baseline[file] ?? 0;
    if (list.length > pinned) {
      errors.push(
        `${file}: ${list.length} light surface(s) without dark handling, ${pinned} pinned:\n` +
          list.map((f) => `    ${file}:${f.line}  ${f.utility}`).join('\n')
      );
    }
  }
  for (const [file, pinned] of Object.entries(baseline)) {
    const now = byFile[file]?.length ?? 0;
    if (now < pinned) errors.push(`${file}: ${now} finding(s), ${pinned} pinned — lower its entry in ${BASELINE_FILE} in this diff.`);
  }
  if (errors.length) {
    console.error('dark mode guard FAILED:\n');
    for (const e of errors) console.error(`  ${e}\n`);
    console.error(
      'Fix: give the element a dark background (`dark:bg-gray-800`, or a `dark:!bg-…` pin for a surface\n' +
        'that must stay light), use a utility the globals.css retint layer already covers (bg-white,\n' +
        'bg-gray-50/100, a retinted *-50 accent), or add the utility to that layer. See CLAUDE.md, Dark mode.'
    );
    process.exit(1);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`dark mode OK — ${covered.size} utilities retinted by globals.css; ${total} pinned finding(s) in ${Object.keys(counts).length} file(s), none new; the baseline only shrinks.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
