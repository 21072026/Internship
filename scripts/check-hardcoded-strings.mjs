#!/usr/bin/env node
// Guard: user-facing copy comes from the dictionaries, not from a JSX literal (#1613).
//
// Why this exists. `npm run check:i18n` enforces EN/TR/DE key PARITY inside
// src/i18n/dictionaries.ts — it cannot see a string that never became a key.
// A screen can therefore ship in raw English and pass every gate, and one did:
// the per-tenant pipeline-stage editor (/admin/organizations/[id]/pipeline)
// was English end to end on a product sold on trilingual delivery. Locale-less
// date formatting has its own guard (check:locale-dates, #1422); this one
// covers the copy itself.
//
// What it flags, from the TypeScript AST of every .tsx under src/app and
// src/components (a real parser, never a JSX regex):
//   1. a JSX text node with a word of two or more letters in it;
//   2. a `placeholder`, `title`, `aria-label` or `alt` attribute given a
//      string literal with a word in it.
// Expressions (`{t.foo.bar}`) are never flagged — that is the translated path.
//
// A RATCHET, not a sweep. The tree carries findings that other issues own
// (#1418, #1377, #1354 and the long tail), so the counts per file are pinned in
// scripts/hardcoded-strings-baseline.json and the check fails BOTH ways:
//   - a file with more findings than its pinned count (or a new file with any)
//     fails with every finding's file:line and text — new copy goes through
//     the dictionaries;
//   - a file with FEWER findings than pinned fails too, asking for the number
//     to be lowered in the same diff, so the baseline only ever shrinks
//     (the EXPECTED_LEAKS discipline of check:i18n).
// `--write-baseline` rewrites the counts from the tree; use it only to LOWER
// them (the diff shows a reviewer which way they moved).
//
// The allowlists below are for genuine non-copy (brand names, symbols, the
// product's own terms that are never translated). Every entry carries its
// reason; an entry without one fails the check.
//
// This is a FLOOR, not proof of translation quality: it cannot tell a good
// Turkish string from a bad one, and copy built in a .ts helper is outside it.
//
// Run: node scripts/check-hardcoded-strings.mjs   (npm run check:hardcoded-strings)

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const DIRS = ['src/app', 'src/components'];
const BASELINE_FILE = 'scripts/hardcoded-strings-baseline.json';
const ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt']);
const WORD = /[A-Za-zÀ-ÖØ-öø-ÿĞğİıŞşÇçÖöÜü]{2,}/;

// Exact texts that are not copy, with the reason.
const ALLOW_TEXT = {
  OK: 'Universal acknowledgement, identical in EN/TR/DE.',
  PDF: 'A file format name.',
  CSV: 'A file format name.',
  URL: 'A technical term, identical in EN/TR/DE.',
  API: 'A technical term, identical in EN/TR/DE.',
  LinkedIn: 'A brand name.',
  GitHub: 'A brand name.',
  Google: 'A brand name.',
  WhatsApp: 'A brand name.',
  InternshipCRM: 'The product name in the shell wordmark.',
  'GET /api/v1/candidates': 'An HTTP method and path shown as code.',
};

// Whole files that are not user copy, with the reason.
const ALLOW_FILES = {};

const problems = [];
for (const [text, why] of Object.entries(ALLOW_TEXT)) if (!why?.trim()) problems.push(`ALLOW_TEXT '${text}' has no reason.`);
for (const [file, why] of Object.entries(ALLOW_FILES)) if (!why?.trim()) problems.push(`ALLOW_FILES '${file}' has no reason.`);

function tsxFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path));
    else if (entry.endsWith('.tsx')) out.push(path);
  }
  return out;
}

// Not copy by SHAPE, so not listed one by one: an example value in a
// placeholder (a URL, an address, a colour, a path or a slug — no space, and a
// URL/e-mail/path character in it) and an all-caps technical token (DEBUG,
// SAML, KB). Neither is translated in any of the three languages.
const NOT_COPY_SHAPES = [
  /:\/\//,
  // one token carrying @ # / _ : or an inner '.'/'-' (a host, a file, a slug) —
  // but not a word with trailing punctuation such as "Loading..."
  /^[^\s]*([@#/_:]|[.-][A-Za-z0-9])[^\s]*$/,
  /^[A-Z0-9][A-Z0-9 _./+-]*$/,
];

function isCopy(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || !WORD.test(t)) return false;
  if (NOT_COPY_SHAPES.some((re) => re.test(t))) return false;
  return !Object.prototype.hasOwnProperty.call(ALLOW_TEXT, t);
}

function findings(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node) => {
    if (ts.isJsxText(node) && isCopy(node.text)) {
      found.push({ line: at(node), text: node.text.replace(/\s+/g, ' ').trim() });
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(source);
      if (ATTRS.has(name) && isCopy(node.initializer.text)) found.push({ line: at(node), text: `${name}="${node.initializer.text}"` });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const current = {};
const detail = {};
for (const dir of DIRS) {
  for (const path of tsxFiles(join(ROOT, dir))) {
    const file = relative(ROOT, path).replace(/\\/g, '/');
    if (ALLOW_FILES[file]) continue;
    const f = findings(path);
    if (f.length) {
      current[file] = f.length;
      detail[file] = f;
    }
  }
}

if (process.argv.includes('--write-baseline')) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_FILE, JSON.stringify({
    _comment: 'Hardcoded user-facing strings per file (#1613), pinned by scripts/check-hardcoded-strings.mjs. Counts may only go DOWN: fix a file, lower (or delete) its number in the same diff. A new string goes through src/i18n/dictionaries.ts instead.',
    files: sorted,
  }, null, 2) + '\n');
  console.log(`hardcoded strings baseline written — ${Object.keys(sorted).length} file(s), ${Object.values(sorted).reduce((a, b) => a + b, 0)} finding(s).`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).files ?? {};
for (const [file, count] of Object.entries(current)) {
  const pinned = baseline[file] ?? 0;
  if (count > pinned) {
    problems.push(
      `${file}  has ${count} hardcoded string(s), ${pinned} pinned. Put new copy in src/i18n/dictionaries.ts (EN/TR/DE):\n` +
        detail[file].map((f) => `      ${file}:${f.line}  ${JSON.stringify(f.text)}`).join('\n'),
    );
  }
}
for (const [file, pinned] of Object.entries(baseline)) {
  const count = current[file] ?? 0;
  if (count < pinned) {
    problems.push(`${file}  is pinned at ${pinned} but has ${count} — lower its number in ${BASELINE_FILE} (delete the line at 0) so the ratchet keeps the gain.`);
  }
}

if (problems.length) {
  console.error('hardcoded strings FAILED — user-facing copy belongs in the dictionaries:\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nSee the header of scripts/check-hardcoded-strings.mjs (#1613).');
  process.exit(1);
}
const total = Object.values(current).reduce((a, b) => a + b, 0);
console.log(`hardcoded strings OK — ${total} pinned finding(s) in ${Object.keys(current).length} file(s), none new; the baseline only shrinks.`);
