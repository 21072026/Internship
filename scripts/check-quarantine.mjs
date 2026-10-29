#!/usr/bin/env node
// Every quarantined e2e test is on a deadline (#1610).
//
// WHY THIS EXISTS
//   The old answer to a flaky spec was "re-run it". That teaches everybody to
//   read red as noise, which is exactly how a real regression ships. A test
//   tagged `@quarantine` is instead left out of every gating run
//   (playwright.config.ts) and run again, non-gating, by the scheduled full
//   suite — so it still runs and still reports, but it no longer decides
//   whether a PR is green.
//
//   A quarantine nobody comes back to is a deleted test with extra steps. So
//   each one must say, in a comment directly above the tag:
//
//     // quarantine: #1234 until 2026-11-30 — what is flaky and why
//
//   and this check fails when the issue link or the date is missing, when the
//   date has passed, or when it is more than MAX_DAYS away. At the expiry the
//   test is fixed (and the tag removed) or deleted — never re-dated just to
//   pass this check (docs/testing.md § Flaky tests).
//
// Run: node scripts/check-quarantine.mjs   (npm run check:quarantine)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_DAYS = 30;
// The tag as it appears in a test's options: '@quarantine' or "@quarantine".
const TAG = /(['"`])@quarantine\1/;
const NOTE = /quarantine:\s*#(\d+)\s+until\s+(\d{4}-\d{2}-\d{2})\b/;
// How far above the tag the note may sit: the comment line, the `test(` line
// and an options line in between.
const LOOKBACK = 4;

const DAY = 24 * 60 * 60 * 1000;
const utcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/**
 * files: [{ path, text }]; today: Date. Returns { entries, errors }, where an
 * entry is { file, line, issue, until } for every well-formed quarantine.
 */
export function checkQuarantine(files, today = new Date()) {
  const entries = [];
  const errors = [];
  const t0 = utcDay(today);
  for (const { path: file, text } of files) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!TAG.test(line) || line.trim().startsWith('//')) return;
      const where = `${file}:${i + 1}`;
      let note = null;
      for (let j = i; j >= Math.max(0, i - LOOKBACK); j--) {
        const m = NOTE.exec(lines[j]);
        if (m) { note = m; break; }
      }
      if (!note) {
        errors.push(`${where}: @quarantine without "// quarantine: #<issue> until YYYY-MM-DD — reason" directly above it`);
        return;
      }
      const [, issue, until] = note;
      const end = Date.parse(`${until}T00:00:00Z`);
      if (Number.isNaN(end)) {
        errors.push(`${where}: quarantine date "${until}" is not a date`);
        return;
      }
      if (end < t0) {
        errors.push(`${where}: quarantine for #${issue} expired on ${until} — fix the test (and drop the tag) or delete it`);
      } else if (end - t0 > MAX_DAYS * DAY) {
        errors.push(`${where}: quarantine for #${issue} runs to ${until}, more than ${MAX_DAYS} days away — the limit is ${MAX_DAYS}`);
      }
      entries.push({ file, line: i + 1, issue: Number(issue), until });
    });
  }
  return { entries, errors };
}

function specFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...specFiles(full));
    else if (/\.(ts|mts|js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = specFiles('e2e').map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
  const { entries, errors } = checkQuarantine(files);
  for (const e of entries) console.log(`quarantined: ${e.file}:${e.line} — #${e.issue} until ${e.until}`);
  if (errors.length) {
    console.error(`\ncheck:quarantine FAILED (${errors.length}):\n${errors.map((e) => `  • ${e}`).join('\n')}`);
    console.error('\nPolicy: docs/testing.md § Flaky tests — quarantine for at most 30 days, then fix or delete.');
    process.exit(1);
  }
  console.log(`check:quarantine: ${entries.length} quarantined test(s), all with an issue and a live expiry.`);
}
