#!/usr/bin/env node
// Dependency vulnerability gate (#885, tightened #2059).
//
// Reads an `npm audit --json` report and decides whether it should stop the
// line. The decision is NOT invented here — it implements the ladder written in
// docs/trust/vulnerability-management.md, which exists so that "which findings
// block?" is a policy question with a written answer rather than a number
// somebody once typed into a YAML file.
//
//   critical                                   -> ALWAYS fails
//   high, fix available and NOT semver-major    -> fails (the fix is `npm audit fix`)
//   high, only a semver-major fix available     -> fails UNLESS documented
//   high, fixAvailable: false                   -> reported, not blocking (owes a doc)
//   moderate / low                              -> reported, never blocking
//
// Why not "any high": the gate this replaces blocked on `critical` only, and
// its header said why — the long-lived `high` findings here have no non-major
// fix, so a high gate would have been red from the day it merged, "and a gate
// that is always red is a gate everyone learns to scroll past". This ladder
// blocks exactly the findings the PR author can act on and routes the rest to
// the documented-exception path.
//
// "Documented" means the package appears in the open-findings table of
// docs/security-exceptions.md WITH a reason. Deliberately not a suppression
// file: the exception and the sentence justifying it are the same artefact, so
// an exception cannot exist without a written reason, and the reason is
// readable next to the other security docs. The parser below therefore reads
// the human document rather than a machine-only allowlist.
//
// Fails closed. A missing, empty, unparseable, or metadata-less report exits
// non-zero: `npm audit` is invoked with `|| true` in the workflow (it exits
// non-zero merely for *having* findings), so an unreachable advisory feed would
// otherwise leave a truncated file behind and read as "no vulnerabilities".
//
// Run: node scripts/check-audit.mjs [path/to/audit.json]   (npm run check:audit)
// Writes a markdown summary to stdout — the workflow tees it into
// $GITHUB_STEP_SUMMARY — and the failure reasons to stderr.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const reportPath = process.argv[2] || 'audit.json';
const EXCEPTIONS_DOC = path.join('docs', 'security-exceptions.md');
const POLICY_DOC = 'docs/trust/vulnerability-management.md';

/** Loud exit for anything that would otherwise pass by accident. */
function bail(message, hint) {
  console.error(`audit gate FAILED (could not evaluate the report):\n\n  - ${message}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Read the report, refusing anything we cannot trust.
// ---------------------------------------------------------------------------

let raw;
try {
  raw = readFileSync(path.resolve(ROOT, reportPath), 'utf8');
} catch (error) {
  bail(
    `cannot read ${reportPath}: ${error.message}`,
    'The workflow runs `npm audit --json > audit.json || true`; if the registry was\nunreachable the file is missing or empty. That must fail, not pass.',
  );
}

if (!raw.trim()) {
  bail(
    `${reportPath} is empty — \`npm audit\` produced no output at all`,
    'Almost always an unreachable advisory feed (offline runner, registry outage,\nproxy). Re-run the job; do not skip the gate.',
  );
}

let report;
try {
  report = JSON.parse(raw);
} catch (error) {
  bail(
    `${reportPath} is not valid JSON: ${error.message}`,
    'A truncated report means the audit was cut off mid-write. Re-run the job.',
  );
}

// npm's own error shape (`{ error: { code, summary } }`) and the v6 report
// shape both lack this block; either way we have no severities to judge.
const counts = report?.metadata?.vulnerabilities;
if (!counts || typeof counts !== 'object') {
  const npmError = report?.error?.summary || report?.error?.code;
  bail(
    `${reportPath} has no metadata.vulnerabilities block${npmError ? ` — npm said: ${npmError}` : ''}`,
    'Either npm reported an error instead of a report, or the report format changed.\nEither way the gate cannot tell "clean" from "unknown", so it fails.',
  );
}

// ---------------------------------------------------------------------------
// 2. Read the documented exceptions out of the human document.
// ---------------------------------------------------------------------------

/**
 * Package names from the open-findings table of docs/security-exceptions.md.
 *
 * The table's first column holds one or more `backticked` package names and the
 * last column holds the reason. A row with an empty reason is not an
 * exception — it is a name somebody pasted in — so it is not collected, and the
 * gate then treats that package as undocumented.
 *
 * Fails closed in both directions: if the document or its table is gone, this
 * throws rather than returning an empty set that would silently look like
 * "nothing is documented" while the surrounding code reports it as normal.
 */
function readDocumentedExceptions() {
  let doc;
  try {
    doc = readFileSync(path.resolve(ROOT, EXCEPTIONS_DOC), 'utf8');
  } catch (error) {
    bail(
      `cannot read ${EXCEPTIONS_DOC}: ${error.message}`,
      `That file is where a carried finding's reason is written (see ${POLICY_DOC}).\nWithout it the gate cannot tell a reviewed exception from an ignored one.`,
    );
  }

  // Everything from the open-findings heading up to the next `## ` heading.
  const section = /\n##\s+Açık bulgular\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(doc);
  if (!section) {
    bail(
      `${EXCEPTIONS_DOC} no longer has an "## Açık bulgular" section`,
      'The gate reads the open-findings table out of that section. If the heading was\nrenamed, update the regex in scripts/check-audit.mjs in the same commit.',
    );
  }

  const documented = new Map();
  for (const line of section[1].split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    // Skip the header row and the |---|---| separator.
    if (/^:?-{2,}/.test(cells[0])) continue;
    const reason = cells[cells.length - 1];
    if (!reason || /^-{2,}/.test(reason)) continue;
    for (const [, name] of cells[0].matchAll(/`([^`]+)`/g)) {
      documented.set(name, reason);
    }
  }
  return documented;
}

const documented = readDocumentedExceptions();

// ---------------------------------------------------------------------------
// 3. Classify every finding.
// ---------------------------------------------------------------------------

/**
 * `fixAvailable` is one of: false (no fix published), true (a fix exists within
 * the declared ranges), or an object naming the package/version to move to —
 * with `isSemVerMajor` telling us whether taking it is a one-line bump or a
 * migration. That distinction is the whole point of the ladder: a non-major fix
 * is something the PR author can take now; a major is a project, and a project
 * needs a written exception rather than a red gate on every unrelated PR.
 */
function classifyFix(fixAvailable) {
  if (fixAvailable === false || fixAvailable == null) return { kind: 'none', label: 'no fix published' };
  if (fixAvailable === true) return { kind: 'minor', label: 'fix available' };
  if (fixAvailable.isSemVerMajor) {
    const target = fixAvailable.name ? `${fixAvailable.name}@${fixAvailable.version}` : 'a new major';
    return { kind: 'major', label: `major upgrade only (${target})` };
  }
  const target = fixAvailable.name ? `${fixAvailable.name}@${fixAvailable.version}` : 'a newer version';
  return { kind: 'minor', label: `fix available (${target})` };
}

const SEVERITY_ORDER = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };

/**
 * The exception reasons are paragraphs — that is the point of keeping them in
 * prose — but a paragraph per row turns the job summary into an unreadable
 * wall. Quote the first sentence and let the doc carry the rest. Pipes would
 * also break the markdown table.
 */
function excerpt(reason, limit = 140) {
  const flat = reason.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const boundary = Math.max(cut.lastIndexOf(' '), limit - 20);
  return `${cut.slice(0, boundary)}… (full reason in ${EXCEPTIONS_DOC})`;
}

const findings = Object.entries(report.vulnerabilities || {}).map(([name, vuln]) => {
  const fix = classifyFix(vuln.fixAvailable);
  const severity = vuln.severity || 'info';
  const reason = documented.get(name);

  let verdict = 'reported';
  let note = '';
  if (severity === 'critical') {
    verdict = 'BLOCKS';
    note = 'critical always blocks — patch, mitigate or drop the dependency (7 days)';
  } else if (severity === 'high') {
    if (fix.kind === 'minor') {
      verdict = 'BLOCKS';
      note = 'a non-major fix is published — take it (`npm audit fix`)';
    } else if (fix.kind === 'major') {
      if (reason) {
        verdict = 'carried';
        note = `documented: ${excerpt(reason)}`;
      } else {
        verdict = 'BLOCKS';
        note = `only a major fix exists — take it, or write the reason in ${EXCEPTIONS_DOC}`;
      }
    } else {
      verdict = reason ? 'carried' : 'owes a doc';
      note = reason
        ? `documented: ${excerpt(reason)}`
        : `no upstream fix — non-blocking, but ${EXCEPTIONS_DOC} owes it a reason within 3 working days`;
    }
  } else if (reason) {
    note = `documented: ${excerpt(reason)}`;
  }

  return { name, severity, fix, verdict, note };
});

findings.sort(
  (a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.name.localeCompare(b.name),
);

const blocking = findings.filter((f) => f.verdict === 'BLOCKS');
const owed = findings.filter((f) => f.verdict === 'owes a doc');
// A documented exception for a package that no longer shows up is doc rot, not
// a build failure: npm audit output changes without anyone committing, so
// failing here would turn the weekly run red for the good news that a finding
// got fixed. Reported, so the next reader knows to prune it.
const flagged = new Set(findings.map((f) => f.name));
const stale = [...documented.keys()].filter((name) => !flagged.has(name));

// ---------------------------------------------------------------------------
// 4. Job summary (stdout) — the workflow tees this into $GITHUB_STEP_SUMMARY.
// ---------------------------------------------------------------------------

const headline =
  `### npm audit — ${counts.critical} critical · ${counts.high} high · ` +
  `${counts.moderate} moderate · ${counts.low} low`;
console.log(headline);
console.log('');

if (findings.length) {
  console.log('| Severity | Package | Fix | Gate | Why |');
  console.log('|---|---|---|---|---|');
  for (const f of findings) {
    const verdict = f.verdict === 'BLOCKS' ? '**blocks**' : f.verdict;
    console.log(`| ${f.severity} | \`${f.name}\` | ${f.fix.label} | ${verdict} | ${f.note} |`);
  }
} else {
  console.log('No known vulnerabilities.');
}

console.log('');
console.log(
  `Gate policy: critical always blocks; a \`high\` blocks unless its only fix is a semver-major ` +
    `that is documented in \`${EXCEPTIONS_DOC}\`, or no fix is published at all. ` +
    `Full ladder and the remediation SLA: \`${POLICY_DOC}\`.`,
);

if (owed.length) {
  console.log('');
  console.log(
    `⚠️ Not blocking, but owed a written reason in \`${EXCEPTIONS_DOC}\` ` +
      `(3 working days per the SLA): ${owed.map((f) => `\`${f.name}\``).join(', ')}.`,
  );
}

if (stale.length) {
  console.log('');
  console.log(
    `ℹ️ \`${EXCEPTIONS_DOC}\` still carries ${stale.map((n) => `\`${n}\``).join(', ')}, ` +
      `which \`npm audit\` no longer reports — good news; prune the row and update the review date.`,
  );
}

// ---------------------------------------------------------------------------
// 5. Verdict.
// ---------------------------------------------------------------------------

if (blocking.length) {
  console.error(`\naudit gate FAILED — ${blocking.length} blocking finding(s):\n`);
  for (const f of blocking) console.error(`  - ${f.severity} \`${f.name}\` (${f.fix.label}) — ${f.note}`);
  console.error(`\nThe ladder and the remediation targets are in ${POLICY_DOC}.`);
  console.error(`Carrying a finding instead of fixing it means writing the reason in ${EXCEPTIONS_DOC}.\n`);
  process.exit(1);
}

console.error(
  `audit gate OK — ${findings.length} finding(s), 0 blocking` +
    `${owed.length ? `, ${owed.length} owed a documented reason` : ''}` +
    `${stale.length ? `, ${stale.length} stale exception row(s)` : ''}.`,
);
