#!/usr/bin/env node
/**
 * Parse-checks every k6 script in `k6/`.
 *
 * WHY THIS EXISTS. Nothing else looks at that directory. `next lint` only visits
 * `app/pages/components/lib/src`, and `tsconfig.json`'s `include` lists only
 * `**\/*.ts|tsx`, so a `k6/*.js` file is invisible to both gates in `ci.yml`.
 * Without this, a typo in a k6 script — a mistyped threshold key, a stray comma,
 * a renamed import — is first observed at 23:40 UTC when the nightly cron fires,
 * and reaches the maintainer as a red "the load test crashed" email rather than
 * as a failed PR check.
 *
 * `k6 archive` performs a full bundle + init-context evaluation without sending
 * a single request, so it catches syntax errors, bad imports, invalid `options`
 * keys and thresholds naming a non-existent metric — all statically.
 *
 * k6 is a standalone binary, not an npm dependency. When it is absent this skips
 * with a warning (so a contributor without k6 installed is not blocked by a
 * check they cannot run) — unless `K6_CHECK_REQUIRED=1`, which CI sets, so a
 * broken k6 install cannot silently disable the gate there.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const K6_DIR = 'k6';
const required = process.env.K6_CHECK_REQUIRED === '1';

function haveK6() {
  const probe = spawnSync('k6', ['version'], { encoding: 'utf8' });
  return probe.status === 0 ? (probe.stdout || '').trim() : null;
}

const version = haveK6();
if (!version) {
  const msg =
    'k6 binary not found on PATH — cannot parse-check k6/. ' +
    'Install it from https://grafana.com/docs/k6/latest/set-up/install-k6/';
  if (required) {
    console.error(`::error title=k6 check could not run::${msg}`);
    process.exit(1);
  }
  console.log(`::warning title=k6 check skipped::${msg}`);
  process.exit(0);
}

let scripts;
try {
  scripts = readdirSync(K6_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => path.join(K6_DIR, f));
} catch {
  console.log(`No ${K6_DIR}/ directory — nothing to check.`);
  process.exit(0);
}

// An empty k6/ would silently pass, which looks identical to "all scripts fine".
// If the directory exists it is because scripts live in it.
if (scripts.length === 0) {
  console.error(`::error title=k6 check found nothing::${K6_DIR}/ exists but contains no .js scripts.`);
  process.exit(1);
}

const failures = [];
for (const script of scripts) {
  try {
    // -O /dev/null: we want the validation, not the archive itself.
    execFileSync('k6', ['archive', script, '-O', '/dev/null'], { stdio: 'pipe' });
    console.log(`  ✔ ${script}`);
  } catch (err) {
    const detail = [err.stdout?.toString(), err.stderr?.toString()].filter(Boolean).join('\n').trim();
    failures.push({ script, detail });
    console.log(`  ✖ ${script}`);
  }
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n::error file=${f.script}::k6 could not load ${f.script}\n${f.detail}`);
  }
  process.exit(1);
}

console.log(`k6 scripts OK — ${scripts.length} script(s) parsed with ${version.split('\n')[0]}.`);
