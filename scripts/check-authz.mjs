#!/usr/bin/env node
// Guard: an API route asks the permission layer, not the role string (#1571, story #1565).
//
// WHY THIS EXISTS
//   "May this person do this?" used to be answered in every route by comparing
//   the session's role to 'ADMIN' — hundreds of times, each copy slightly
//   different (401 here, 403 there, a private requireAdmin() helper in thirty
//   files). That comparison cannot express an admin TIER: an OBSERVER and a
//   PROGRAM_ADMIN both have role ADMIN, so every route that compares the string
//   hands them the whole tenant. The answer now lives in ONE place —
//   requirePermission() / can() in src/lib/authz.ts over the pure rule in
//   src/lib/authzRule.ts (docs/role-access-matrix.md § Admin tiers) — and this
//   check stops the next route from going back to the string.
//
//   NOT requireCapability(): that is the per-vertical PRODUCT gate in
//   src/lib/capabilityGate.ts and answers a different question.
//
// WHAT COUNTS
//   Inside src/app/api/**/route.*, with comments stripped:
//     * the caller's role compared to 'ADMIN' — `session.user.role !== 'ADMIN'`,
//       `session?.user?.role === 'ADMIN'`, a bare `role === 'ADMIN'` (in a route
//       handler `role` is the caller's), either operand order;
//     * an array literal holding 'ADMIN' asked `.includes(session.user.role)` /
//       `.includes(role)`;
//     * a local `requireAdmin…` helper (function or const).
//   A comparison about ANOTHER user (`target.role === 'ADMIN'`, `user.role`) is
//   data, not authorization, and is not counted.
//
// THE RATCHET
//   scripts/authz-baseline.json lists, per file, how many such sites are still
//   waiting to be moved (`pending`), plus the sites that legitimately branch on
//   the role for DATA SHAPE rather than access (`allowed`, each with a reason).
//   It is pinned in both directions:
//     * a file that is not listed and has a site fails — use requirePermission();
//     * a file whose count went UP fails — same;
//     * a file whose count went DOWN fails until the number is lowered, and a
//       file that reached zero (or no longer exists) fails until its entry is
//       deleted — so the list can only shrink towards zero.
//   `--shrink` rewrites the baseline with the lower numbers and deletes the
//   empty entries. It never adds an entry or raises a number: a new site is
//   written into the file by hand, if at all, and a reviewer reads it.
//
// Run: node scripts/check-authz.mjs            (npm run check:authz)
//      node scripts/check-authz.mjs --shrink   (after converting routes)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { routeFiles } from './lib/route-files.mjs';

const API_DIR = 'src/app/api';
const BASELINE_FILE = 'scripts/authz-baseline.json';

const ADMIN = `['"\`]ADMIN['"\`]`;
// The caller's role: session.user.role (any optional chaining) or a bare `role`.
const CALLER_ROLE = String.raw`(?:\bsession\??\.user\??\.role\b|(?<![.\w?])role\b)`;

/** Every pattern that answers "is the caller an admin?" by hand. */
export const PATTERNS = [
  { name: 'role compared to ADMIN', re: new RegExp(String.raw`${CALLER_ROLE}\s*[!=]==?\s*${ADMIN}`, 'g') },
  { name: 'ADMIN compared to role', re: new RegExp(String.raw`${ADMIN}\s*[!=]==?\s*${CALLER_ROLE}`, 'g') },
  {
    name: "['ADMIN', …].includes(role)",
    re: new RegExp(String.raw`\[[^\]\n]*${ADMIN}[^\]\n]*\]\s*\.includes\(\s*${CALLER_ROLE}`, 'g'),
  },
  { name: 'local requireAdmin helper', re: /\b(?:function\s+requireAdmin\w*|(?:const|let)\s+requireAdmin\w*\s*=)/g },
];

/**
 * Blank comments, keeping offsets and line breaks so line numbers stay true.
 * Strings are skipped over intact (a `//` inside a URL string is not a
 * comment); this is a scanner, not a parser, and errs towards COUNTING —
 * a missed comment shows up as a site, never as a silent pass.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out += src[i++]; }
        if (i < src.length) out += src[i++];
        if (c !== '`' && src[i - 1] === '\n') break;
      }
      if (i < src.length) out += src[i++];
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The hand-rolled admin checks in one source text: [{ line, pattern }]. */
export function findSites(source) {
  const code = stripComments(source);
  const sites = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) {
      sites.push({ line: code.slice(0, m.index).split('\n').length, pattern: name });
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

/** Compare counts to the baseline. Returns { problems, shrunk } — shrunk is the lowered pending map. */
export function judge(counts, baseline) {
  const pending = baseline.pending ?? {};
  const allowed = baseline.allowed ?? {};
  const problems = [];
  const shrunk = {};
  for (const [file, entry] of Object.entries(allowed)) {
    if (!entry || typeof entry.reason !== 'string' || !entry.reason.trim() || !Number.isInteger(entry.count)) {
      problems.push(`${file}: an "allowed" entry needs an integer count and a reason`);
    }
    if (pending[file] !== undefined) problems.push(`${file}: listed both as pending and as allowed`);
  }
  const files = new Set([...Object.keys(counts), ...Object.keys(pending), ...Object.keys(allowed)]);
  for (const file of [...files].sort()) {
    const have = counts[file] ?? 0;
    const budget = (pending[file] ?? 0) + (allowed[file]?.count ?? 0);
    if (have > budget) {
      problems.push(
        `${file}: ${have} hand-rolled admin check(s), ${budget} allowed — ` +
          `authorize through requirePermission() / can() (src/lib/authz.ts), not the role string`,
      );
    } else if (have < budget) {
      problems.push(
        `${file}: ${have} hand-rolled admin check(s) but the baseline says ${budget} — ` +
          `lower it (npm run check:authz -- --shrink); the list only shrinks`,
      );
    }
    if (pending[file] !== undefined) {
      const left = Math.min(pending[file], Math.max(0, have - (allowed[file]?.count ?? 0)));
      if (left > 0) shrunk[file] = left;
    }
  }
  return { problems, shrunk };
}

export function scanTree(dir = API_DIR) {
  const counts = {};
  const detail = {};
  for (const file of routeFiles(dir)) {
    const sites = findSites(readFileSync(file, 'utf8'));
    if (sites.length) {
      counts[file] = sites.length;
      detail[file] = sites;
    }
  }
  return { counts, detail };
}

function main() {
  const shrink = process.argv.includes('--shrink');
  if (!existsSync(BASELINE_FILE)) {
    console.error(`check:authz: ${BASELINE_FILE} is missing`);
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  const { counts, detail } = scanTree();
  const { problems, shrunk } = judge(counts, baseline);

  if (shrink) {
    // Only ever lower: an entry that would have to grow keeps its old number and still fails.
    const next = {};
    for (const [file, n] of Object.entries(baseline.pending ?? {})) {
      if (shrunk[file] !== undefined) next[file] = Math.min(n, shrunk[file]);
    }
    baseline.pending = next;
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
    const after = judge(counts, baseline);
    console.log(`check:authz --shrink: ${Object.keys(next).length} file(s) still pending`);
    if (after.problems.length) {
      for (const p of after.problems) console.error(`  ✗ ${p}`);
      process.exit(1);
    }
    return;
  }

  const pendingSites = Object.values(baseline.pending ?? {}).reduce((a, b) => a + b, 0);
  if (problems.length) {
    console.error(`check:authz: ${problems.length} problem(s)`);
    for (const p of problems) {
      console.error(`  ✗ ${p}`);
      const file = p.slice(0, p.indexOf(':'));
      for (const s of detail[file] ?? []) console.error(`      ${file}:${s.line}  ${s.pattern}`);
    }
    process.exit(1);
  }
  console.log(
    `check:authz: OK — ${pendingSites} hand-rolled admin check(s) in ` +
      `${Object.keys(baseline.pending ?? {}).length} file(s) still waiting for requirePermission() (#1571)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
