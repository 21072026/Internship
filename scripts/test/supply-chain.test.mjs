// Regression tests for the two supply-chain decision engines (#2059).
//
// WHY THIS EXISTS
//   Both of these are *policy encoded as code*, and both fail silently in the
//   direction that hurts: a licence classifier that answers "permissive" for a
//   licence it has never seen lets a commercial-grant-killing dependency into
//   the tree, and an audit gate that reads an unreachable advisory feed as
//   "no vulnerabilities" is a green check that means nothing. Neither failure
//   shows up in a build, a lint or a type check — the scripts still exit 0.
//   So the guarantees are asserted here instead, offline, with no install and
//   no network:
//
//     scripts/license-policy.mjs   an unclassified SPDX id must resolve to
//                                  `unknown` (which blocks), OR must take the
//                                  best branch and AND the worst, and the
//                                  GPL-2.0-only / -or-later distinction must
//                                  survive — those have *different* answers
//                                  against AGPL-3.0.
//     scripts/check-audit.mjs      the ladder written in
//                                  docs/trust/vulnerability-management.md, and
//                                  fail-closed on a report it cannot trust.
//
// USAGE
//   node --test scripts/test/            (npm run test:supply-chain)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWLIST, VERDICTS, classify, parseSpdx, verdict as verdictInfo } from '../license-policy.mjs';

const CHECK_AUDIT = fileURLToPath(new URL('../check-audit.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// Licence policy
// ---------------------------------------------------------------------------

test('every verdict a classification can return is a declared tier', () => {
  const keys = new Set(VERDICTS.map((tier) => tier.key));
  for (const expression of ['MIT', 'GPL-3.0-only', 'Frobnicate-9.9', '', 'BUSL-1.1']) {
    assert.ok(keys.has(parseSpdx(expression)), `${expression} -> unknown tier`);
  }
});

test('an unclassified licence blocks rather than passing', () => {
  // The whole design rests on this default. If a new SPDX id ever resolves to
  // anything non-blocking, the gate has quietly become decorative.
  for (const expression of [
    'Frobnicate-9.9',
    'NASA-1.3',
    '',
    '   ',
    'SEE LICENSE IN LICENSE.txt',
    'see licence in COPYING',
  ]) {
    assert.equal(parseSpdx(expression), 'unknown', `${JSON.stringify(expression)}`);
    assert.equal(verdictInfo(parseSpdx(expression)).blocks, true);
  }
});

test('permissive and weak-copyleft licences pass; strong copyleft does not', () => {
  for (const expression of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', '0BSD', 'Unlicense']) {
    assert.equal(verdictInfo(parseSpdx(expression)).blocks, false, expression);
  }
  // Library-level copyleft is fine for both questions as long as we ship the
  // package unmodified — that is the documented condition, not an oversight.
  for (const expression of ['LGPL-3.0', 'LGPL-2.1-or-later', 'MPL-2.0', 'EPL-2.0']) {
    assert.equal(parseSpdx(expression), 'weak-copyleft', expression);
    assert.equal(verdictInfo(parseSpdx(expression)).blocks, false, expression);
  }
});

test('a copyleft dependency blocks the commercial grant even though AGPL distribution is fine', () => {
  // This is the case the whole check exists for: `npm ls --licenses`-style
  // tooling calls GPL-3.0 "compatible" because it is asking only question 1.
  for (const expression of ['GPL-3.0-only', 'GPL-3.0-or-later', 'AGPL-3.0', 'AGPL-3.0-or-later', 'SSPL-1.0', 'EUPL-1.2']) {
    assert.equal(parseSpdx(expression), 'blocks-commercial', expression);
    assert.equal(verdictInfo(parseSpdx(expression)).blocks, true, expression);
  }
});

test('GPL-2.0-only and GPL-2.0-or-later get different answers', () => {
  // GPL-2.0-only has no upgrade path, so it cannot be combined with AGPL-3.0 at
  // all; the `-or-later` variant lets a recipient take GPL-3.0, which AGPL-3.0
  // is compatible with. Collapsing the two is the classic way to get this
  // wrong, in either direction.
  assert.equal(parseSpdx('GPL-2.0-only'), 'incompatible');
  assert.equal(parseSpdx('GPL-2.0-or-later'), 'blocks-commercial');
  // Bare, suffix-less `GPL-2.0` is ambiguous in npm metadata: take the
  // stricter reading rather than guessing in our own favour.
  assert.equal(parseSpdx('GPL-2.0'), 'incompatible');
});

test('non-free and source-available licences are incompatible, not merely awkward', () => {
  for (const expression of ['BUSL-1.1', 'Elastic-2.0', 'CC-BY-NC-4.0', 'UNLICENSED']) {
    assert.equal(parseSpdx(expression), 'incompatible', expression);
  }
});

test('OR takes the best branch and AND takes the worst', () => {
  assert.equal(parseSpdx('(MIT OR GPL-3.0)'), 'permissive');
  assert.equal(parseSpdx('MIT OR Apache-2.0'), 'permissive');
  // Every term of an AND binds, so one bad term poisons the expression.
  assert.equal(parseSpdx('(MIT AND GPL-3.0)'), 'blocks-commercial');
  assert.equal(parseSpdx('MIT AND CC-BY-4.0'), 'attribution');
  // Nested, and with the blocking term inside the parentheses.
  assert.equal(parseSpdx('(MIT OR (Apache-2.0 AND AGPL-3.0))'), 'permissive');
});

test('a trailing + is the same licence as -or-later', () => {
  assert.equal(parseSpdx('LGPL-3.0+'), parseSpdx('LGPL-3.0-or-later'));
  assert.equal(parseSpdx('GPL-3.0+'), 'blocks-commercial');
});

test('a WITH exception keeps the base verdict rather than guessing', () => {
  assert.equal(parseSpdx('GPL-3.0 WITH Classpath-exception-2.0'), 'blocks-commercial');
  assert.equal(parseSpdx('Apache-2.0 WITH LLVM-exception'), 'permissive');
});

test('classification is case-insensitive about SPDX ids', () => {
  assert.equal(parseSpdx('mit'), 'permissive');
  assert.equal(parseSpdx('agpl-3.0-only'), 'blocks-commercial');
});

test('a package with no declared licence is unknown, not permissive', () => {
  const result = classify({ name: 'mystery', version: '1.0.0', license: null });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.source, 'missing');
  assert.equal(verdictInfo(result.verdict).blocks, true);
});

test('every allowlist entry carries a written reason and resolves to a real licence', () => {
  // The reason is rendered verbatim into docs/legal/third-party-licenses.md, so
  // an entry without one would publish a blank justification to a buyer.
  for (const [key, entry] of Object.entries(ALLOWLIST)) {
    assert.equal(typeof entry.reason, 'string', `${key} has no reason`);
    assert.ok(entry.reason.trim().length > 80, `${key}'s reason is too short to be a reason`);
    assert.notEqual(parseSpdx(entry.spdx), 'unknown', `${key} resolves to an unclassified licence`);
  }
});

// ---------------------------------------------------------------------------
// Audit ladder
// ---------------------------------------------------------------------------

/** A minimal `docs/security-exceptions.md` with the table the gate parses. */
function exceptionsDoc(rows) {
  return [
    '# Kabul edilen bağımlılık bulguları',
    '',
    '## Açık bulgular',
    '',
    '| Paket | Şiddet | Gerekçe |',
    '|---|---|---|',
    ...rows.map(([name, reason]) => `| \`${name}\` | high | ${reason} |`),
    '',
    '## Kapatma kriteri',
    '',
    'Bir bulgu ancak şu üç madde yazıldıysa kapatılır.',
  ].join('\n');
}

/**
 * Run the gate in a throwaway directory, so it reads the exceptions document we
 * hand it rather than the repository's real one. Returns `{ status, stdout }`.
 */
function runGate(report, { exceptions = [], omitDoc = false, raw = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-gate-'));
  try {
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    if (!omitDoc) {
      writeFileSync(path.join(dir, 'docs', 'security-exceptions.md'), exceptionsDoc(exceptions));
    }
    writeFileSync(path.join(dir, 'audit.json'), raw ?? JSON.stringify(report));
    const run = spawnSync(process.execPath, [CHECK_AUDIT, 'audit.json'], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { status: run.status, stdout: run.stdout || '', stderr: run.stderr || '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An `npm audit --json` report with the given findings. */
function report(vulnerabilities) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const vuln of Object.values(vulnerabilities)) {
    counts[vuln.severity] = (counts[vuln.severity] || 0) + 1;
    counts.total += 1;
  }
  return { vulnerabilities, metadata: { vulnerabilities: counts } };
}

test('a clean report passes', () => {
  const run = runGate(report({}));
  assert.equal(run.status, 0);
  assert.match(run.stdout, /No known vulnerabilities/);
});

test('a critical finding always blocks, documented or not', () => {
  const vulns = { evil: { severity: 'critical', fixAvailable: false } };
  assert.equal(runGate(report(vulns)).status, 1);
  // There is deliberately no exception path in the gate for a critical.
  assert.equal(
    runGate(report(vulns), { exceptions: [['evil', 'We have thought about it at length.']] }).status,
    1,
  );
});

test('a high with a non-major fix blocks — the remediation is one command', () => {
  assert.equal(runGate(report({ leaky: { severity: 'high', fixAvailable: true } })).status, 1);
  assert.equal(
    runGate(
      report({ leaky: { severity: 'high', fixAvailable: { name: 'leaky', version: '1.2.4', isSemVerMajor: false } } }),
    ).status,
    1,
  );
  // …and writing a reason does NOT buy it a pass: taking the patch is cheaper
  // than the paragraph justifying not taking it.
  assert.equal(
    runGate(report({ leaky: { severity: 'high', fixAvailable: true } }), {
      exceptions: [['leaky', 'A long and superficially plausible justification for not upgrading.']],
    }).status,
    1,
  );
});

test('a high whose only fix is a major blocks until the reason is written', () => {
  const vulns = {
    chunky: { severity: 'high', fixAvailable: { name: 'chunky', version: '4.0.0', isSemVerMajor: true } },
  };
  assert.equal(runGate(report(vulns)).status, 1);
  const documented = runGate(report(vulns), {
    exceptions: [['chunky', 'The fix is a major bump; the vulnerable path is never called from src/.']],
  });
  assert.equal(documented.status, 0);
  assert.match(documented.stdout, /carried/);
});

test('a row with an empty reason cell is not an exception', () => {
  // The reason IS the exception. A bare package name pasted into the table must
  // not buy a pass, or the document becomes a suppression file with extra steps.
  const vulns = {
    chunky: { severity: 'high', fixAvailable: { name: 'chunky', version: '4.0.0', isSemVerMajor: true } },
  };
  assert.equal(runGate(report(vulns), { exceptions: [['chunky', '']] }).status, 1);
});

test('a high with no upstream fix does not block, but is reported as owing a reason', () => {
  const run = runGate(report({ orphaned: { severity: 'high', fixAvailable: false } }));
  assert.equal(run.status, 0);
  assert.match(run.stdout, /owes a doc|owed a written reason/);
});

test('moderate and low findings are reported, never blocking', () => {
  const run = runGate(
    report({
      meh: { severity: 'moderate', fixAvailable: { name: 'meh', version: '2.0.0', isSemVerMajor: true } },
      trivial: { severity: 'low', fixAvailable: true },
    }),
  );
  assert.equal(run.status, 0);
  assert.match(run.stdout, /moderate/);
});

test('a stale exception row is reported, not fatal', () => {
  // npm audit output changes without anyone committing, so the good news that a
  // carried finding got fixed must not turn the weekly run red.
  const run = runGate(report({}), { exceptions: [['gone', 'Fixed upstream last month; row not yet pruned.']] });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /gone/);
});

test('the gate fails closed on a report it cannot trust', () => {
  // Each of these is what an unreachable advisory feed actually leaves behind,
  // because the workflow runs `npm audit --json > audit.json || true`.
  assert.equal(runGate(null, { raw: '' }).status, 1, 'empty file');
  assert.equal(runGate(null, { raw: '{"vulnerabilities":{' }).status, 1, 'truncated JSON');
  assert.equal(
    runGate(null, { raw: JSON.stringify({ error: { code: 'ENETUNREACH', summary: 'offline' } }) }).status,
    1,
    'npm error object',
  );
  assert.equal(runGate(null, { raw: JSON.stringify({ vulnerabilities: {} }) }).status, 1, 'no metadata block');
});

test('the gate fails closed when the exceptions document is missing', () => {
  const run = runGate(report({}), { omitDoc: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /security-exceptions\.md/);
});
