#!/usr/bin/env node
// Guard: a canonical pipeline stage key must not be hardcoded in src/ (#1886).
//
// WHY THIS EXISTS
//   Since #747 the pipeline stages are per-tenant rows (`PipelineStage`), and
//   `resolvePipelineStages()` falls back to the canonical defaults for an org
//   that has none. That fallback is why a hardcoded `'HIRED_660'` is invisible:
//   it type-checks (the column is a String), it passes every test on the default
//   seed, and it only misbehaves for a customer who renamed their stages — which
//   no test tenant does. The bug has been reintroduced repeatedly (#1880 and its
//   tasks #1882/#1884/#1634), so it gets a mechanical guard rather than another
//   round of review vigilance.
//
// WHAT IT ALLOWS
//   Two files legitimately name the defaults, listed in ALLOWED below.
//   Everything else must go through `resolvePipelineStages()` / `onPathKeys()`.
//
//   The offenders already on `main` are recorded in
//   scripts/stage-keys-baseline.json as a SHRINKING RATCHET: a baselined file
//   may keep (or lower) its recorded count, but a file that is NOT listed — a
//   newly reintroduced literal, the case this guard exists for — fails the
//   build. The baseline file is deleted once it reaches `{}`.
//
// Comment lines are stripped before matching: this file, funnelKpi.ts and the
// funnel route all *document* the keys in prose, and a guard that fires on its
// own documentation gets disabled instead of obeyed.
//
// Run: node scripts/check-stage-keys.mjs            (npm run check:stage-keys)
//      node scripts/check-stage-keys.mjs --update    rewrite the baseline

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
// Overridable so the guard itself can be exercised against a fixture.
const positional = args.filter((a) => !a.startsWith('--'));
const ROOTS = positional.length > 0 ? positional : ['src'];

const BASELINE_FILE = 'scripts/stage-keys-baseline.json';

// The canonical default keys. Not the whole catalogue — these are the ones a
// consumer reaches for when it wants "hired", "applied" or "dropped out", which
// is exactly the reasoning that silently breaks on a renamed pipeline.
const KEYS =
  /\b(HIRED_660|EMPLOYED_700|APPLICATION_100|INTERNSHIP_DROPPED_460|INTERNSHIP_FOUND_ELSEWHERE_800)\b/g;

// Files that are allowed to name a default key, and why.
const ALLOWED = {
  // The canonical default stage catalogue itself — these keys ARE the defaults,
  // and every tenant-aware consumer resolves through it.
  'src/lib/pipeline.ts': 'the canonical default stage catalogue',
  // DEFAULT_HIRED_STAGE_KEY: the documented fallback for a tenant whose own
  // stage set declares no terminal stage.
  'src/lib/offers.ts': 'DEFAULT_HIRED_STAGE_KEY, the documented fallback',
};

// A file that has never been triaged gets the parent story as its owner; the
// task issues keep the files the triage already attributed to them.
const DEFAULT_OWNER = '#1880';

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

// Line-start only: enough to skip prose, and cheaper to reason about than
// telling a trailing `// ...` apart from a string that contains `//`.
const isCommentLine = (line) => /^(\/\/|\*|\/\*)/.test(line.trim());

// path -> [{ line, key }]
const hits = new Map();
for (const file of sourceFiles(ROOTS)) {
  const rel = file.split('\\').join('/');
  if (ALLOWED[rel]) continue;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (isCommentLine(line)) return;
      KEYS.lastIndex = 0;
      let m;
      while ((m = KEYS.exec(line))) {
        if (!hits.has(rel)) hits.set(rel, []);
        hits.get(rel).push({ line: i + 1, key: m[1] });
      }
    });
}

const { _comment, ...recorded } = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
const byPath = [...hits].sort((a, b) => a[0].localeCompare(b[0]));

if (UPDATE) {
  const next = { _comment };
  for (const [file, found] of byPath) {
    next[file] = { hits: found.length, issue: recorded[file]?.issue ?? DEFAULT_OWNER };
  }
  writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`stage keys — baseline rewritten: ${byPath.length} file(s) recorded.`);
  process.exit(0);
}

const failures = [];
const stale = [];

for (const [file, found] of byPath) {
  const allowance = recorded[file];
  if (!allowance) {
    // The case this guard exists for: a literal in a file nobody signed off on.
    for (const h of found) failures.push(`${file}:${h.line}  ${h.key}`);
  } else if (found.length > allowance.hits) {
    failures.push(
      `${file}  ${found.length} hardcoded key(s), baseline allows ${allowance.hits} ` +
        `(${allowance.issue}) — hits at line(s) ${found.map((h) => h.line).join(', ')}`
    );
  } else if (found.length < allowance.hits) {
    stale.push(`${file}  ${allowance.hits} → ${found.length}`);
  }
}

// A baselined file that is now clean (or was renamed away) is stale too. Never
// a failure: a cleanup PR must be nudged, not blocked.
for (const [file, allowance] of Object.entries(recorded)) {
  if (!hits.has(file)) stale.push(`${file}  ${allowance.hits} → 0`);
}

if (failures.length > 0) {
  console.error('stage keys FAILED — a canonical pipeline stage key is hardcoded:\n');
  for (const failure of failures) console.error(`  • ${failure}`);
  console.error(
    '\nStages are per-tenant since #747, so resolve them instead of naming a key:\n' +
      '  server:  const stages = await resolvePipelineStages(orgId); onPathKeys(stages)\n' +
      '  client:  useResolvedStages() / useStageLabel()\n' +
      `Allowed to name a default: ${Object.keys(ALLOWED).join(', ')}.\n` +
      `Offenders awaiting cleanup live in ${BASELINE_FILE} — that list may only shrink.`
  );
  process.exit(1);
}

const remaining = byPath.reduce((n, [, found]) => n + found.length, 0);
console.log(
  `stage keys OK — no new hardcoded key; ${remaining} known hit(s) in ` +
    `${byPath.length} baselined file(s) still to clean up.`
);
if (stale.length > 0) {
  console.log('\nBaseline is now generous (good — run `node scripts/check-stage-keys.mjs --update`):');
  for (const s of stale) console.log(`  • ${s}`);
}
