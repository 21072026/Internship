#!/usr/bin/env node
// Unit tests + a per-file coverage floor (#1599).
//
// WHY THIS EXISTS
//   Coverage that nothing enforces is a number nobody looks at. Four modules
//   under src/lib carry real unit tests today, and every one of them was
//   written *because* something broke: the mentor directory's truncation flag
//   (#1820), the shared rate-limit store and its fail-safe fallback (#1696),
//   and the time-in-stage aggregation that reported visits as candidates
//   (#1427). Nothing stops the next refactor from deleting a rule and its
//   assertions in the same diff — the suite would stay green because the test
//   that would have failed no longer exists. A floor notices; a green tick does
//   not.
//
//   The floor is PER FILE on purpose. A repo-wide percentage is a number nobody
//   acts on: it moves when unrelated code lands, so it can only ever be argued
//   down (#1591).
//
// WHICH RUNNER
//   This repo already has two test runners and does not need a third. Pure
//   logic runs under `node --test` (scripts/test/*.test.mjs, Node's own runner,
//   which since v22 both strips TypeScript and measures coverage with no
//   dependency at all); anything that needs a browser or a database runs under
//   Playwright (e2e/). So the coverage harness is Node's, and the whole gate
//   costs zero new packages and about two seconds.
//
// THE RATCHET (the rule, stated once here and again in docs/testing.md)
//   A floor goes UP when a module gains tests. It is never lowered to make a
//   PR pass — a PR that would drop a module below its floor has deleted
//   coverage, and deleting coverage is the thing this file exists to notice.
//   Every floor below is the value measured on main at the time it was added,
//   rounded DOWN to the nearest 5 and capped at 95, so the gate is green on day
//   one and has a little headroom for an honest refactor. It is a ratchet, not
//   a wish.
//
// Run: node scripts/check-unit-coverage.mjs   (npm run test:unit:coverage)

import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  appendFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DIR = 'scripts/test';

// ── The floors ───────────────────────────────────────────────────────────────
// file → { floor, measured, why }
//   floor    — the LINE coverage percentage below which this check fails.
//   measured — what the file scored on main when the floor was last moved, so a
//              reviewer can see the headroom without running anything.
//   why      — the incident the suite pins down, so a floor is never just a
//              number somebody liked.
//
// Lines only. Branch and function percentages are printed in the table (they
// are useful when reading a drop) but are deliberately not gated: branch % is
// the noisiest of the three, and a gate that goes red for a reason nobody can
// act on is a gate that gets deleted.
const FLOORS = new Map([
  [
    'src/lib/mentorDirectory.ts',
    { floor: 95, measured: 100.0, why: 'scan cap / truncated-result reporting (#1820)' },
  ],
  [
    'src/lib/rateLimitRedis.ts',
    { floor: 85, measured: 86.67, why: 'shared-store transport and its outage fallback (#1696)' },
  ],
  [
    'src/lib/rateLimitStore.ts',
    {
      floor: 95,
      measured: 98.78,
      why: 'rate limits are shared across replicas, and fail safe (#1696)',
    },
  ],
  [
    'src/lib/stageAging.ts',
    { floor: 95, measured: 100.0, why: 'stage visits counted separately from candidates (#1427)' },
  ],
  [
    'src/lib/lastContactRule.ts',
    { floor: 95, measured: 100.0, why: 'what counts as contact: 1:1 yes, group only if the mentee wrote it (#2275)' },
  ],
  [
    'src/lib/plans.ts',
    { floor: 95, measured: 99.56, why: 'the plan -> feature matrix and its free-tier fallbacks (#1731)' },
  ],
  [
    'src/lib/menteeFilter.ts',
    {
      floor: 95,
      measured: 100.0,
      why: 'diacritic/dotless-ı folding — mentor search for Şahin/Müller/Işık (#1367)',
    },
  ],
]);

// ── Awaiting tests (a ratchet, not an allowlist) ─────────────────────────────
// The six modules Waves 0-1 are about to rewrite (#1592). Every one of them is
// pure, and every one of them scores 0% under this runner today: `pipeline.ts`
// and `relativeTime.ts` do have unit assertions, but those live in
// e2e/*.unit.spec.ts and run under Playwright, which measures nothing. That
// split is exactly what #1598 exists to close.
//
// They are listed here rather than given a floor of 0 because a floor of 0 can
// never fail and would read, on the summary table, as coverage. An entry only
// ever leaves this list by moving to FLOORS with a real number: the moment a
// module here is *exercised* by the node runner the check FAILS and says so, so
// the floor lands in the same diff as the first test rather than months later.
// Exercised, not merely imported — see MIN_FLOOR below for why the difference
// decides whether this check goes red. The size is pinned by EXPECTED_AWAITING
// so the set cannot grow quietly.
const AWAITING_TESTS = new Map([
  ['src/lib/orgContext.ts', 'wave-0 rewrite (#1549); tenant registry + middleware'],
  ['src/lib/entitlements.ts', 'wave-1 billing-subject collapse (#1592)'],
  ['src/lib/planGate.ts', 'wave-1 billing-subject collapse (#1592)'],
  ['src/lib/pipeline.ts', 'assertions exist, but under Playwright — needs #1598'],
  ['src/lib/dormantFirstContact.ts', '"two mails, never a third" (docs/dormant-first-contacts.md)'],
  ['src/lib/relativeTime.ts', 'assertions exist, but under Playwright — needs #1598'],
]);

// How many entries AWAITING_TESTS is allowed to hold. Pinned as a literal for
// the same reason check-tenant-models.mjs pins its pending set: a seventh
// unfloored module cannot be waved through by appending a line, and the count
// only moves in a diff a human approved.
const EXPECTED_AWAITING = 6;

const TRACKED = [...FLOORS.keys(), ...AWAITING_TESTS.keys()];

// ── What counts as "covered", and the lowest floor worth writing ─────────────
// A floor is only protection if it sits above the score a module gets for
// merely being imported. `pipeline.ts` is the worked example: it is almost
// entirely top-level const stage/label tables, so a test that imports it and
// asserts nothing at all executes 85% of its lines while calling none of its
// nine functions. Promoting that would pin an 85% floor the ratchet then
// forbids ever lowering — the gate would certify module *loading* as coverage,
// and #1592's real pipeline suite would land under a floor it already
// satisfied before it was written. Worse, the PR that trips it is usually a
// test for some *other* module that happens to import this one, so its author
// is handed a failure they cannot act on except by writing a fake floor.
//
// So an AWAITING_TESTS entry is "newly covered" only when something in it
// actually RAN: at least one of its functions was called. A module that
// declares no functions at all — a pure table — is judged on lines alone,
// because there is nothing else to call.
//
// MIN_FLOOR is the other half of the same idea. `Math.floor(lines / 5) * 5`
// returns 0 for anything under 5%, and the AWAITING_TESTS comment above already
// says why a floor of 0 is worse than no floor: it can never fail, yet it reads
// as coverage on the summary table and quietly drops the module off the
// knowingly-unprotected list. Below MIN_FLOOR no floor is suggested and the
// entry stays exactly where it is.
const MIN_FLOOR = 25;

const suggestFloor = (lines) => Math.min(95, Math.floor(lines / 5) * 5);
const exercised = (m) => (m.fnf === 0 ? m.lines > 0 : m.fnh > 0);

// ── Both lists must name files that still exist ──────────────────────────────
// Nothing else compares either map to the tree, and the two failure modes are
// silent in opposite directions. A deleted module in AWAITING_TESTS never
// appears in the lcov, which is indistinguishable from "no tests yet", so the
// row rots forever while EXPECTED_AWAITING still looks honest — and wave-1 is
// specified to delete `planGate.ts` when it collapses the billing subject
// (#1592), so this is on the path, not hypothetical. A *renamed* module under a
// floor is the mirror image: it drops to 0% and fails with "restore the
// assertions this change removed", which is the wrong advice for a rename, and
// the documented ratchet gives no sanctioned way to edit the entry. Both get
// their own message, before the suite runs.
const missing = TRACKED.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error('\nunit coverage FAILED:\n');
  for (const file of missing) {
    console.error(
      `  • ${file} is listed in scripts/check-unit-coverage.mjs but no longer exists. ` +
        'It was renamed or deleted, so its coverage cannot be measured and its entry is ' +
        'advertising a module that is not there: point the entry at the new path, or remove ' +
        'it — and if it was an AWAITING_TESTS entry, move EXPECTED_AWAITING in the same diff.',
    );
  }
  process.exit(1);
}

// ── Run the suite under Node's coverage ──────────────────────────────────────

function testFiles() {
  const files = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join(TEST_DIR, name));
  if (files.length === 0) throw new Error(`No *.test.mjs found in ${TEST_DIR}/`);
  return files;
}

const outDir = mkdtempSync(path.join(tmpdir(), 'unit-coverage-'));
const lcovPath = path.join(outDir, 'lcov.info');

// `--test-coverage-include` is narrowed to the tracked list on purpose: the
// table is the thing a reviewer reads, and a row for every file the suite
// happens to touch buries the ones that actually carry a floor.
const args = [
  '--test',
  '--experimental-strip-types',
  '--experimental-test-coverage',
  ...TRACKED.map((file) => `--test-coverage-include=${file}`),
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=lcov',
  `--test-reporter-destination=${lcovPath}`,
  ...testFiles(),
];

const run = spawnSync(process.execPath, args, { stdio: 'inherit' });

if (run.error) {
  rmSync(outDir, { recursive: true, force: true });
  throw run.error;
}
if (run.status !== 0) {
  // The tests themselves failed. Coverage is beside the point until they pass,
  // and printing a floor table under a red suite only buries the real message.
  rmSync(outDir, { recursive: true, force: true });
  console.error(
    '\nunit tests FAILED — fix the assertions above; the coverage floor was not evaluated.',
  );
  process.exit(run.status ?? 1);
}

// ── Read the lcov ────────────────────────────────────────────────────────────
// A file the suite never loads does not appear in the report at all, which is
// indistinguishable from 0% and is treated as exactly that.

function parseLcov(text) {
  const results = new Map();
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      current = { lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
      results.set(line.slice(3), current);
    } else if (line === 'end_of_record') {
      current = null;
    } else if (current) {
      const sep = line.indexOf(':');
      if (sep < 0) continue;
      const key = line.slice(0, sep);
      const value = Number(line.slice(sep + 1));
      if (key === 'LF') current.lf = value;
      else if (key === 'LH') current.lh = value;
      else if (key === 'BRF') current.brf = value;
      else if (key === 'BRH') current.brh = value;
      else if (key === 'FNF') current.fnf = value;
      else if (key === 'FNH') current.fnh = value;
    }
  }
  return results;
}

const coverage = parseLcov(readFileSync(lcovPath, 'utf8'));
rmSync(outDir, { recursive: true, force: true });

const pct = (hit, found) => (found > 0 ? (hit * 100) / found : 0);
const fmt = (value) => value.toFixed(2).padStart(6);

function measure(file) {
  const c = coverage.get(file);
  if (!c) return { lines: 0, branch: 0, funcs: 0, fnf: 0, fnh: 0, seen: false };
  return {
    lines: pct(c.lh, c.lf),
    branch: pct(c.brh, c.brf),
    funcs: pct(c.fnh, c.fnf),
    // Raw counts, not just the percentage: `exercised()` needs to tell "no
    // function ran" (fnh 0 of 9) from "there are no functions" (fnf 0), and
    // both render as 0.00%.
    fnf: c.fnf,
    fnh: c.fnh,
    seen: c.lf > 0,
  };
}

// ── Verdict ──────────────────────────────────────────────────────────────────

const problems = [];
const rows = [];
// Reached by the suite but not exercised by it. Said out loud, never red — it
// is a normal state for a module some other test transitively imports.
const loadedOnly = [];

for (const [file, { floor, why }] of FLOORS) {
  const m = measure(file);
  const ok = m.lines >= floor;
  rows.push({ file, ...m, floor, why, status: ok ? 'ok' : 'below floor' });
  if (!ok) {
    problems.push(
      `${file} is at ${m.lines.toFixed(2)}% line coverage, below its floor of ${floor}%. ` +
        'Restore the assertions this change removed. Lowering the floor is not the fix — ' +
        'see docs/testing.md § The coverage ratchet.',
    );
  }
}

for (const [file, reason] of AWAITING_TESTS) {
  const m = measure(file);
  const floor = suggestFloor(m.lines);
  const covered = m.seen && exercised(m) && floor >= MIN_FLOOR;
  rows.push({
    file,
    ...m,
    floor: null,
    why: reason,
    status: covered ? 'NEWLY COVERED' : m.seen ? 'loaded, not exercised' : 'no tests yet',
  });
  if (covered) {
    problems.push(
      `${file} now scores ${m.lines.toFixed(2)}% line / ${m.funcs.toFixed(2)}% function ` +
        'coverage under the node runner — it is no longer untested. Move it from ' +
        'AWAITING_TESTS to FLOORS in scripts/check-unit-coverage.mjs ' +
        `(floor ${floor}%, i.e. rounded down to the nearest 5 and capped at 95) and drop ` +
        'EXPECTED_AWAITING by one, in this same PR.',
    );
  } else if (m.seen) {
    loadedOnly.push(
      !exercised(m)
        ? `${file} — ${m.lines.toFixed(2)}% of its lines ran, but none of its ${m.fnf} ` +
          'function(s) were called. Something imports it; nothing exercises it. Loading a ' +
          'module is not coverage, so no floor is suggested and the entry stays put.'
        : `${file} — only ${m.lines.toFixed(2)}% of its lines ran, which rounds to a floor ` +
          `below the ${MIN_FLOOR}% minimum. A floor that low can never fail while still ` +
          'reading as coverage, so no floor is suggested and the entry stays put.',
    );
  }
}

if (AWAITING_TESTS.size !== EXPECTED_AWAITING) {
  problems.push(
    `AWAITING_TESTS holds ${AWAITING_TESTS.size} entr${AWAITING_TESTS.size === 1 ? 'y' : 'ies'}, ` +
      `but EXPECTED_AWAITING says ${EXPECTED_AWAITING}. The set of knowingly unfloored modules ` +
      'is pinned to a literal so it cannot change quietly: move the number in the same diff and ' +
      'say in the PR why a module was added to — or removed from — the unfloored list.',
  );
}

// ── The table ────────────────────────────────────────────────────────────────
// Printed to the log always, and to the GitHub job summary when there is one,
// so a reviewer sees where each module stands without opening the step.

const header = `${'file'.padEnd(32)} | line % | floor | branch % | funcs % | status`;
const rule = '-'.repeat(header.length);
console.log(`\n${rule}\n${header}\n${rule}`);
for (const r of rows) {
  const floorCell = r.floor === null ? '  —  ' : `${String(r.floor).padStart(3)}% `;
  console.log(
    `${r.file.padEnd(32)} | ${fmt(r.lines)} | ${floorCell} | ` +
      `${fmt(r.branch)}   | ${fmt(r.funcs)}  | ${r.status}`,
  );
}
console.log(rule);

if (process.env.GITHUB_STEP_SUMMARY) {
  const badge = (status) => {
    if (status === 'ok') return '✅ ok';
    if (status === 'no tests yet') return '⏳ no tests yet';
    if (status === 'loaded, not exercised') return '⚠️ loaded, not exercised';
    return `❌ ${status}`;
  };
  const md = [
    '### Unit coverage floor (#1599)',
    '',
    'Line coverage of the modules under a floor, plus the wave-0/1 modules still waiting for one.',
    'Floors move **up** only — see `docs/testing.md` § The coverage ratchet.',
    '',
    '| Module | Line % | Floor | Branch % | Funcs % | Status | Why |',
    '| --- | ---: | ---: | ---: | ---: | --- | --- |',
    ...rows.map(
      (r) =>
        `| \`${r.file}\` | ${r.lines.toFixed(2)} | ${r.floor === null ? '—' : `${r.floor}%`} | ` +
        `${r.branch.toFixed(2)} | ${r.funcs.toFixed(2)} | ${badge(r.status)} | ${r.why} |`,
    ),
    '',
  ].join('\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}

if (loadedOnly.length > 0) {
  console.warn(
    `\nunit coverage: ${loadedOnly.length} module(s) awaiting a suite are reached by the tests ` +
      'but not exercised by them — no floor is suggested for these:',
  );
  for (const line of loadedOnly) console.warn(`  • ${line}`);
}

if (problems.length > 0) {
  console.error('\nunit coverage FAILED:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

// Modules with no floor at all are not a hard failure — writing their suites is
// #1598's and the waves' reviewed work, not this guard's — but they ARE the
// blast radius of three upcoming refactors, so they get said out loud on every
// run, with an annotation so the PR page shows it rather than burying it in a
// green step.
const awaiting = [...AWAITING_TESTS.keys()];
if (awaiting.length > 0) {
  const headline =
    `${awaiting.length} wave-0/1 module(s) have no coverage under this runner and therefore no ` +
    'floor — a refactor can delete a rule from them and nothing goes red:';
  const lines = awaiting.map((file) => `  • ${file} — ${AWAITING_TESTS.get(file)}`);
  if (process.env.GITHUB_ACTIONS) {
    console.log(
      `::warning title=Modules with no coverage floor::${[headline, ...lines].join('%0A')}`,
    );
  }
  console.warn(`\nunit coverage: ${headline}`);
  for (const line of lines) console.warn(line);
}

const verdict =
  awaiting.length > 0
    ? `unit coverage: no floor breached, but ${awaiting.length} module(s) still have none (#1592)`
    : 'unit coverage OK';
console.log(
  `\n${verdict} — ${FLOORS.size} module(s) under a per-file line floor, all at or above it; ` +
    `${awaiting.length} awaiting a suite. Floors only move up ` +
    '(docs/testing.md § The coverage ratchet).',
);
