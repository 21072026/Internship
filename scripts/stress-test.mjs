#!/usr/bin/env node
/**
 * Stress / load test harness (dependency-free, Node 18+ native fetch).
 *
 * Hammers a set of public, read-only GET endpoints with sustained concurrency
 * for a fixed duration, then reports throughput, latency percentiles and the
 * error rate. Exits non-zero when any configured threshold is breached, so it
 * can gate CI / the nightly cron and trigger the failure-email alert.
 *
 * It only issues GET requests to unauthenticated, side-effect-free routes —
 * it never mutates data — so it is safe to run against a live preview/prod env.
 *
 * Configuration (all via env, with sane defaults):
 *   BASE_URL         target origin              (default http://localhost:3000)
 *   STRESS_PATHS     comma-separated paths      (default "/,/auth/signin,/api/health")
 *   STRESS_CONCURRENCY  parallel workers        (default 20)
 *   STRESS_DURATION_MS  test duration in ms     (default 20000)
 *   STRESS_TIMEOUT_MS   per-request timeout     (default 10000)
 *   STRESS_MAX_ERROR_RATE  fail above this      (default 0.02  => 2%)
 *   STRESS_MAX_P95_MS   fail if p95 above this  (default 2000)
 *   STRESS_MIN_RPS      fail if throughput below (default 0 => disabled)
 *   STRESS_WARMUP_MS    ignore results before   (default 1000)
 *
 * Usage:
 *   BASE_URL=https://crm-preview.ersah.in node scripts/stress-test.mjs
 */
import { writeFileSync } from 'node:fs';

// Read a numeric env var, honouring an explicit 0 (a plain `Number(x) || d`
// would silently drop 0 back to the default — wrong for e.g. a zero-tolerance
// error threshold or a disabled warmup).
function numEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const PATHS = (process.env.STRESS_PATHS || '/,/auth/signin,/api/health')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);
const CONCURRENCY = numEnv('STRESS_CONCURRENCY', 20);
const DURATION_MS = numEnv('STRESS_DURATION_MS', 20_000);
const TIMEOUT_MS = numEnv('STRESS_TIMEOUT_MS', 10_000);
const WARMUP_MS = numEnv('STRESS_WARMUP_MS', 1_000);
const MAX_ERROR_RATE = numEnv('STRESS_MAX_ERROR_RATE', 0.02);
const MAX_P95_MS = numEnv('STRESS_MAX_P95_MS', 2_000);
const MIN_RPS = numEnv('STRESS_MIN_RPS', 0);

// Aggregate incrementally so memory stays flat (~a few counters) regardless of
// how many requests a long soak fires, instead of retaining one object each.
const okLatencies = []; // latency samples for successful responses only
let totalCount = 0;
let failCount = 0;
/** @type {Record<string, { total: number; failures: number }>} */
const byPath = {};
let warmupUntil = 0;

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

function record(path, ok, ms) {
  totalCount++;
  const agg = (byPath[path] ??= { total: 0, failures: 0 });
  agg.total++;
  if (ok) {
    // Only successful responses feed the latency percentiles — otherwise a
    // timeout (recorded at ~TIMEOUT_MS) or a fast connection-refused would
    // distort the p95 latency gate.
    okLatencies.push(ms);
  } else {
    failCount++;
    agg.failures++;
  }
}

async function hit(path) {
  const url = BASE_URL + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();
  // Warmup is keyed off request *start* so a slow cold-start request that
  // begins during warmup is excluded even if it completes after the window.
  const counted = start >= warmupUntil;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'user-agent': 'internship-crm-stress-test' },
    });
    // Drain the body so the connection can be reused and timing reflects a full response.
    await res.arrayBuffer().catch(() => {});
    // 2xx and 3xx are healthy for these public routes (signin may redirect).
    const ok = res.status >= 200 && res.status < 400;
    if (counted) record(path, ok, performance.now() - start);
  } catch {
    if (counted) record(path, false, performance.now() - start);
  } finally {
    clearTimeout(timer);
  }
}

let pathIndex = 0;
async function worker(deadline) {
  while (performance.now() < deadline) {
    const path = PATHS[pathIndex++ % PATHS.length];
    await hit(path);
  }
}

async function main() {
  console.log(`\n▶ Stress test: ${BASE_URL}`);
  console.log(`  paths=${PATHS.join(' ')}`);
  console.log(
    `  concurrency=${CONCURRENCY} duration=${DURATION_MS}ms warmup=${WARMUP_MS}ms timeout=${TIMEOUT_MS}ms`
  );
  console.log(
    `  thresholds: errorRate<=${(MAX_ERROR_RATE * 100).toFixed(1)}% p95<=${MAX_P95_MS}ms` +
      (MIN_RPS ? ` rps>=${MIN_RPS}` : '')
  );

  const startedAt = new Date().toISOString();
  const testStart = performance.now();
  warmupUntil = testStart + WARMUP_MS;
  const deadline = testStart + DURATION_MS;

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(deadline)));

  // Guard against warmup >= duration, which would divide by zero / go negative.
  const measuredMs = Math.max(1, DURATION_MS - WARMUP_MS);
  const total = totalCount;
  const errorRate = total === 0 ? 1 : failCount / total;
  const latencies = okLatencies.sort((a, b) => a - b);
  const rps = total / (measuredMs / 1000);

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const avg = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);
  const max = latencies[latencies.length - 1] || 0;

  console.log(`\n── Results (${(measuredMs / 1000).toFixed(1)}s measured window) ──`);
  console.log(`  requests:   ${total}`);
  console.log(`  throughput: ${rps.toFixed(1)} req/s`);
  console.log(`  errors:     ${failCount} (${(errorRate * 100).toFixed(2)}%)`);
  console.log(
    `  latency ms (successful responses): avg=${avg.toFixed(0)} p50=${p50.toFixed(0)} p95=${p95.toFixed(0)} p99=${p99.toFixed(0)} max=${max.toFixed(0)}`
  );
  for (const [path, agg] of Object.entries(byPath)) {
    console.log(`    ${path}: ${agg.total} reqs, ${agg.failures} errors`);
  }

  const breaches = [];
  if (errorRate > MAX_ERROR_RATE) {
    breaches.push(`error rate ${(errorRate * 100).toFixed(2)}% > ${(MAX_ERROR_RATE * 100).toFixed(1)}%`);
  }
  if (p95 > MAX_P95_MS) {
    breaches.push(`p95 ${p95.toFixed(0)}ms > ${MAX_P95_MS}ms`);
  }
  if (MIN_RPS && rps < MIN_RPS) {
    breaches.push(`throughput ${rps.toFixed(1)} req/s < ${MIN_RPS} req/s`);
  }
  if (total === 0) {
    breaches.push('no requests completed (target unreachable?)');
  }

  // Emit a machine-readable summary for the CI/cron job and email alert.
  const summary = {
    baseUrl: BASE_URL,
    startedAt,
    total,
    errors: failCount,
    errorRate: Number(errorRate.toFixed(4)),
    rps: Number(rps.toFixed(1)),
    latencyMs: { avg: Math.round(avg), p50: Math.round(p50), p95: Math.round(p95), p99: Math.round(p99), max: Math.round(max) },
    thresholds: { maxErrorRate: MAX_ERROR_RATE, maxP95Ms: MAX_P95_MS, minRps: MIN_RPS },
    breaches,
    passed: breaches.length === 0,
  };

  if (process.env.STRESS_SUMMARY_FILE) {
    writeFileSync(process.env.STRESS_SUMMARY_FILE, JSON.stringify(summary, null, 2));
    console.log(`\n  summary written to ${process.env.STRESS_SUMMARY_FILE}`);
  }

  if (breaches.length > 0) {
    console.error(`\n✖ STRESS TEST FAILED:\n  - ${breaches.join('\n  - ')}\n`);
    process.exit(1);
  }
  console.log(`\n✔ Stress test passed — all thresholds within limits.\n`);
}

main().catch((err) => {
  console.error('Stress test crashed:', err);
  process.exit(2);
});
