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

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const PATHS = (process.env.STRESS_PATHS || '/,/auth/signin,/api/health')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);
const CONCURRENCY = Number(process.env.STRESS_CONCURRENCY) || 20;
const DURATION_MS = Number(process.env.STRESS_DURATION_MS) || 20_000;
const TIMEOUT_MS = Number(process.env.STRESS_TIMEOUT_MS) || 10_000;
const WARMUP_MS = Number(process.env.STRESS_WARMUP_MS) || 1_000;
const MAX_ERROR_RATE = Number(process.env.STRESS_MAX_ERROR_RATE) || 0.02;
const MAX_P95_MS = Number(process.env.STRESS_MAX_P95_MS) || 2_000;
const MIN_RPS = Number(process.env.STRESS_MIN_RPS) || 0;

/** @type {{ ok: boolean; status: number; ms: number; path: string; error?: string }[]} */
const samples = [];
let warmupUntil = 0;

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

async function hit(path) {
  const url = BASE_URL + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'user-agent': 'internship-crm-stress-test' },
    });
    // Drain the body so the connection can be reused and timing reflects a full response.
    await res.arrayBuffer().catch(() => {});
    const ms = performance.now() - start;
    // 2xx and 3xx are healthy for these public routes (signin may redirect).
    const ok = res.status >= 200 && res.status < 400;
    if (performance.now() >= warmupUntil) {
      samples.push({ ok, status: res.status, ms, path });
    }
  } catch (err) {
    const ms = performance.now() - start;
    if (performance.now() >= warmupUntil) {
      samples.push({ ok: false, status: 0, ms, path, error: err?.name || String(err) });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function worker(deadline, counter) {
  while (performance.now() < deadline) {
    const path = PATHS[counter.i++ % PATHS.length];
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

  const testStart = performance.now();
  warmupUntil = testStart + WARMUP_MS;
  const deadline = testStart + DURATION_MS;
  const counter = { i: 0 };

  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker(deadline, counter))
  );

  const measuredMs = DURATION_MS - WARMUP_MS;
  const total = samples.length;
  const failures = samples.filter((s) => !s.ok);
  const errorRate = total === 0 ? 1 : failures.length / total;
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const rps = total / (measuredMs / 1000);

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const avg = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);
  const max = latencies[latencies.length - 1] || 0;

  // Per-path status-code breakdown for quick diagnosis.
  const byPath = {};
  for (const s of samples) {
    byPath[s.path] ??= { total: 0, failures: 0 };
    byPath[s.path].total++;
    if (!s.ok) byPath[s.path].failures++;
  }

  console.log(`\n── Results (${(measuredMs / 1000).toFixed(1)}s measured window) ──`);
  console.log(`  requests:   ${total}`);
  console.log(`  throughput: ${rps.toFixed(1)} req/s`);
  console.log(`  errors:     ${failures.length} (${(errorRate * 100).toFixed(2)}%)`);
  console.log(
    `  latency ms: avg=${avg.toFixed(0)} p50=${p50.toFixed(0)} p95=${p95.toFixed(0)} p99=${p99.toFixed(0)} max=${max.toFixed(0)}`
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
    startedAt: new Date().toISOString(),
    total,
    errors: failures.length,
    errorRate: Number(errorRate.toFixed(4)),
    rps: Number(rps.toFixed(1)),
    latencyMs: { avg: Math.round(avg), p50: Math.round(p50), p95: Math.round(p95), p99: Math.round(p99), max: Math.round(max) },
    thresholds: { maxErrorRate: MAX_ERROR_RATE, maxP95Ms: MAX_P95_MS, minRps: MIN_RPS },
    breaches,
    passed: breaches.length === 0,
  };

  if (process.env.STRESS_SUMMARY_FILE) {
    const { writeFileSync } = await import('node:fs');
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
