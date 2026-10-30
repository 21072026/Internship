#!/usr/bin/env node
// Guard: a notification leaves through the router, not a hand-written send (#1711).
//
// WHY THIS EXISTS
//   Every place that decided "and also send an e-mail / a push / a bell row" used
//   to carry its own copy of the preference check (`emailAllowed(…) &&
//   emailGroupAllowedForCategory(…)`), and the copies drifted — src/lib/emailGroups.ts
//   documents the bug that mismatch caused. The decision now lives ONCE, in
//   `notifyEvent()` (src/lib/notifications/router.ts) and its channel adapters
//   (src/lib/notifications/adapters/), with a ledger row per delivery. This check
//   stops the next feature from going back to a raw send.
//
// WHAT COUNTS (comments stripped, src/** outside src/lib/notifications/)
//   * a call to `sendEmail(`         — the mail transport (the adapter enqueues it);
//   * a call to `sendPushToUser(`    — the push transport (adapters/push.ts);
//   * `prisma.notification.create(` / `createMany(` — a bell row written by hand.
//   A function DECLARATION (`function sendEmail(`) is not a call and does not count.
//
// THE RATCHET
//   scripts/notify-baseline.json pins, per file, the raw sends still waiting to
//   move behind the router (`pending`) and the ones that stay by decision
//   (`allowed`, each with a reason — the transport's own internals, newsletter
//   dispatch with its own consent model, the security notices' inline mail…).
//   Pinned in both directions, exactly like check:authz: a new file with a site
//   fails, a count that went up fails, and a count that went down fails until
//   the entry is lowered (`npm run check:notify -- --shrink`), so the list only
//   ever shrinks towards zero.
//
// Run: node scripts/check-notify.mjs            (npm run check:notify)
//      node scripts/check-notify.mjs --shrink   (after migrating send sites)

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './check-authz.mjs';

const SRC_DIR = 'src';
const ROUTER_DIR = 'src/lib/notifications/';
const BASELINE_FILE = 'scripts/notify-baseline.json';

/** Every way of sending past the router. */
export const PATTERNS = [
  { name: 'raw sendEmail()', re: /(?<!function\s)\bsendEmail\s*\(/g },
  { name: 'raw sendPushToUser()', re: /(?<!function\s)\bsendPushToUser\s*\(/g },
  { name: 'hand-written bell row', re: /\bprisma\.notification\.create(?:Many)?\s*\(/g },
];

/** The raw sends in one source text: [{ line, pattern }]. */
export function findSites(source) {
  const code = stripComments(source);
  const sites = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) sites.push({ line: code.slice(0, m.index).split('\n').length, pattern: name });
  }
  return sites.sort((a, b) => a.line - b.line);
}

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

export function scanTree(dir = SRC_DIR) {
  const counts = {};
  const detail = {};
  for (const file of sourceFiles(dir)) {
    if (file.startsWith(ROUTER_DIR)) continue;
    const sites = findSites(readFileSync(file, 'utf8'));
    if (sites.length) {
      counts[file] = sites.length;
      detail[file] = sites;
    }
  }
  return { counts, detail };
}

/** Compare counts to the baseline. Returns { problems, shrunk }. */
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
        `${file}: ${have} raw send(s), ${budget} allowed — send through notifyEvent() ` +
          `(src/lib/notifications/router.ts) and a catalogue event, not sendEmail()/sendPushToUser()/notification.create`,
      );
    } else if (have < budget) {
      problems.push(`${file}: ${have} raw send(s) but the baseline says ${budget} — lower it (npm run check:notify -- --shrink); the list only shrinks`);
    }
    if (pending[file] !== undefined) {
      const left = Math.min(pending[file], Math.max(0, have - (allowed[file]?.count ?? 0)));
      if (left > 0) shrunk[file] = left;
    }
  }
  return { problems, shrunk };
}

function main() {
  const shrink = process.argv.includes('--shrink');
  if (!existsSync(BASELINE_FILE)) {
    console.error(`check:notify: ${BASELINE_FILE} is missing`);
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  const { counts, detail } = scanTree();
  const { problems, shrunk } = judge(counts, baseline);

  if (shrink) {
    // Only ever lower: an entry that would have to grow keeps its number and still fails.
    const next = {};
    for (const [file, n] of Object.entries(baseline.pending ?? {})) {
      if (shrunk[file] !== undefined) next[file] = Math.min(n, shrunk[file]);
    }
    baseline.pending = next;
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
    const after = judge(counts, baseline);
    console.log(`check:notify --shrink: ${Object.keys(next).length} file(s) still pending`);
    if (after.problems.length) {
      for (const p of after.problems) console.error(`  ✗ ${p}`);
      process.exit(1);
    }
    return;
  }

  if (problems.length) {
    console.error(`check:notify: ${problems.length} problem(s)`);
    for (const p of problems) {
      console.error(`  ✗ ${p}`);
      const file = p.slice(0, p.indexOf(':'));
      for (const s of detail[file] ?? []) console.error(`      ${file}:${s.line}  ${s.pattern}`);
    }
    process.exit(1);
  }
  const pendingSites = Object.values(baseline.pending ?? {}).reduce((a, b) => a + b, 0);
  console.log(
    `check:notify: OK — ${pendingSites} raw send(s) in ${Object.keys(baseline.pending ?? {}).length} file(s) ` +
      `still waiting to move behind notifyEvent() (#1711)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
