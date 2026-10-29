#!/usr/bin/env node
// Per-test reliability across scheduled e2e runs (#1610).
//
// WHY THIS EXISTS
//   Playwright retries once in CI, so a test that fails and then passes is
//   GREEN — and the only trace of it was a 7-day artifact nobody opens. With
//   nothing kept between runs, "is this spec getting worse?" had no answer, and
//   the standing advice for a red run was to re-run it. This keeps a compact
//   record of every scheduled full run and reads it back as pass rate and retry
//   rate per test, so a flake is a number, not a feeling.
//
// WHERE THE HISTORY LIVES
//   One JSON line per run in `history.jsonl` on the `test-history` branch,
//   written by the scheduled full suite (.github/workflows/e2e-full.yml). A
//   branch rather than an artifact chain or the cache: both of those expire or
//   get evicted, and a branch is plain text anyone can read or `git log`.
//   Bounded to the last MAX_RUNS runs so it never grows without limit.
//
// USAGE
//   node scripts/e2e-reliability.mjs record --reports <dir> [--quarantine <dir>]
//        --history <file> --run <id> --sha <sha>
//   node scripts/e2e-reliability.mjs report --history <file> [--runs 40] [--top 10]
//
// A record line: { run, sha, at, tests: [{ id, title, status, retries, ms, q }] }
//   status: pass (first try) | flaky (passed on a retry) | fail | skip
//   q:      1 when the test was quarantined (ran in the non-gating step)

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_RUNS = 200;

const STATUS = { expected: 'pass', flaky: 'flaky', unexpected: 'fail', skipped: 'skip' };

/** Flatten one Playwright JSON report into per-test records. */
export function recordsFromReport(report, { quarantined = false } = {}) {
  const out = [];
  const walk = (suites, chain) => {
    for (const s of suites ?? []) {
      const next = s.title ? [...chain, s.title] : chain;
      for (const spec of s.specs ?? []) {
        const file = spec.file || s.file || '?';
        const title = [...next.slice(1), spec.title].join(' › ').replace(/[\r\n]/g, ' ').slice(0, 200);
        for (const t of spec.tests ?? []) {
          const results = t.results ?? [];
          const tags = spec.tags ?? [];
          out.push({
            id: `${file} › ${title}`,
            title,
            status: STATUS[t.status] ?? 'fail',
            retries: Math.max(0, results.length - 1),
            ms: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
            ...(quarantined || tags.some((g) => String(g).replace(/^@/, '') === 'quarantine') ? { q: 1 } : {}),
          });
        }
      }
      walk(s.suites, next);
    }
  };
  walk(report?.suites, []);
  return out;
}

/**
 * Per-test numbers over the last `runs` entries of a history. A test that was
 * skipped in a run does not count for that run. Returns every test with at
 * least one counted run, least reliable first.
 */
export function summarize(history, { runs = 40 } = {}) {
  const window = history.slice(-runs);
  const byId = new Map();
  for (const run of window) {
    for (const t of run.tests ?? []) {
      if (t.status === 'skip') continue;
      const s = byId.get(t.id) ?? { id: t.id, runs: 0, pass: 0, flaky: 0, fail: 0, q: false };
      s.runs += 1;
      s[t.status] = (s[t.status] ?? 0) + 1;
      if (t.q) s.q = true;
      byId.set(t.id, s);
    }
  }
  const rows = [...byId.values()].map((s) => ({
    ...s,
    passRate: s.pass / s.runs,
    retryRate: (s.flaky + s.fail) / s.runs,
  }));
  rows.sort((a, b) => a.passRate - b.passRate || b.fail - a.fail || a.id.localeCompare(b.id));
  return { runs: window.length, tests: rows };
}

const pct = (x) => `${Math.round(x * 100)}%`;

/** The job-summary / e-mail table: the least reliable tests that were not perfect. */
export function markdown(summary, { top = 10 } = {}) {
  const shaky = summary.tests.filter((t) => t.passRate < 1).slice(0, top);
  const head = `### Least reliable e2e tests (last ${summary.runs} scheduled run${summary.runs === 1 ? '' : 's'})`;
  if (summary.runs === 0) return `${head}\n\nNo history yet.`;
  if (shaky.length === 0) return `${head}\n\nEvery test passed on its first try in every run. 🎉`;
  const lines = [
    head,
    '',
    'First-try pass rate; a flaky run passed only on the retry. `Q` = quarantined (#1610).',
    '',
    '| Test | Runs | Pass | Flaky | Fail | Pass rate |',
    '|---|---:|---:|---:|---:|---:|',
    ...shaky.map((t) => `| ${t.q ? '`Q` ' : ''}\`${t.id.replace(/\|/g, '\\|')}\` | ${t.runs} | ${t.pass} | ${t.flaky} | ${t.fail} | ${pct(t.passRate)} |`),
  ];
  return lines.join('\n');
}

export function parseHistory(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
}

function readReports(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try { return [JSON.parse(readFileSync(path.join(dir, f), 'utf8'))]; } catch { return []; }
    });
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const historyFile = arg('history', 'history.jsonl');
  const history = existsSync(historyFile) ? parseHistory(readFileSync(historyFile, 'utf8')) : [];
  if (mode === 'record') {
    const tests = [
      ...readReports(arg('reports')).flatMap((r) => recordsFromReport(r)),
      ...readReports(arg('quarantine')).flatMap((r) => recordsFromReport(r, { quarantined: true })),
    ];
    if (tests.length === 0) {
      console.log('e2e-reliability: no report to record — nothing written.');
      process.exit(0);
    }
    const line = { run: arg('run', ''), sha: arg('sha', ''), at: new Date().toISOString(), tests };
    const kept = [...history, line].slice(-MAX_RUNS);
    writeFileSync(historyFile, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`e2e-reliability: recorded ${tests.length} test result(s); history holds ${kept.length} run(s).`);
  } else if (mode === 'report') {
    const summary = summarize(history, { runs: Number(arg('runs', 40)) });
    console.log(markdown(summary, { top: Number(arg('top', 10)) }));
  } else {
    console.error('usage: e2e-reliability.mjs record|report …');
    process.exit(2);
  }
}
