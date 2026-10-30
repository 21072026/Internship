/**
 * SSE load test — the demo environment ONLY (#1612).
 *
 * Holds N concurrent `GET /api/realtime/stream` connections and measures what
 * docs/realtime-and-push.md says nobody had measured: how long a stream takes
 * to open under N open streams, and how far the server's 25 s heartbeat drifts
 * when N of them share one event loop. Each heartbeat also re-reads the unread
 * counters from MySQL, so heartbeat drift is the visible symptom of that
 * per-connection database cost.
 *
 * HOW, given that k6 cannot read a response incrementally: the stream route
 * accepts `?maxSeconds=` (clamped 5 s…30 min, it can only SHORTEN a stream), so
 * each VU opens a stream that the server closes after HOLD_SECONDS, and k6 then
 * reads the whole body. The route stamps every heartbeat comment with the server
 * clock (`: ping <epoch ms>`), so the gaps between consecutive pings are the
 * server's actual beat.
 *
 * Metrics (all tagged, all thresholded):
 *   http_req_waiting{ep:sse_stream}  time until the stream's headers arrive = setup time
 *   sse_ready                        rate of streams that delivered the `ready` event
 *   sse_heartbeat_drift_ms           |gap between pings − 25 000 ms|
 *
 * SAFETY: same target guard and published demo credentials as
 * k6/authenticated-load.js (k6/lib/demoTarget.js). Read-only — a stream writes
 * nothing. The route caps 6 streams per user, so connections are spread over
 * all 12 demo accounts (≤ 72 concurrent).
 *
 *   K6_SMOKE=1 K6_PEAK_VUS=3 k6 run k6/sse-load.js   # ~1 min
 *   K6_SSE_CONNECTIONS=40 k6 run k6/sse-load.js     # default 24
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { assertDemoTarget, baseUrl, DEMO_ACCOUNTS, signIn } from './lib/demoTarget.js';

const HEARTBEAT_MS = 25_000; // src/app/api/realtime/stream/route.ts
const PER_USER_CAP = 6; //      MAX_CONNECTIONS_PER_USER in src/lib/realtimeBus.ts

function numEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const BASE_URL = baseUrl();
const SMOKE = __ENV.K6_SMOKE === '1';
const ACCOUNTS = DEMO_ACCOUNTS.admin.length + DEMO_ACCOUNTS.mentor.length + DEMO_ACCOUNTS.mentee.length;
// K6_PEAK_VUS is honoured too, so the smoke command line matches the other scenarios.
const CONNECTIONS = Math.min(
  ACCOUNTS * PER_USER_CAP,
  Math.max(1, Math.round(numEnv('K6_SSE_CONNECTIONS', numEnv('K6_PEAK_VUS', SMOKE ? 3 : 24))))
);
// Two beats need > 50 s; the full run holds long enough for several.
const HOLD_SECONDS = SMOKE ? 51 : Math.max(52, Math.round(numEnv('K6_SSE_HOLD_SECONDS', 130)));
const SUMMARY_FILE = __ENV.K6_SUMMARY_FILE || 'k6-sse-summary.json';

const ready = new Rate('sse_ready');
const drift = new Trend('sse_heartbeat_drift_ms');
// How many ping-to-ping intervals were observed — `count>0` proves a beat was measured at all.
const beats = new Counter('sse_heartbeat_intervals');

export const options = {
  userAgent: 'internship-crm-k6/1.0 (+SSE demo load test; github actions)',
  maxRedirects: 0,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '2m',
  thresholds: {
    // Headers must come back fast even with N streams open: opening one is a
    // session read and a subscribe, nothing more.
    'http_req_waiting{ep:sse_stream}': ['p(95)<1500'],
    'http_req_failed{ep:sse_stream}': ['rate<0.02'],
    'http_reqs{ep:sse_stream}': ['count>0'],
    'http_req_duration{ep:auth}': ['p(95)<2500'],
    'http_reqs{ep:auth}': ['count>0'],
    // Every stream must say `ready` (its first counter read) before it closes.
    sse_ready: ['rate>0.98'],
    // A beat more than 2 s late means the event loop or the counter query is
    // backing up under N streams.
    sse_heartbeat_drift_ms: ['p(95)<2000'],
    sse_heartbeat_intervals: ['count>0'],
  },
  scenarios: {
    streams: {
      executor: 'per-vu-iterations',
      vus: CONNECTIONS,
      iterations: 1,
      maxDuration: `${HOLD_SECONDS + 60}s`,
    },
  },
};

export function setup() {
  assertDemoTarget(BASE_URL);
  const cookies = [];
  // One account per connection up to all twelve: spreads the streams as widely
  // as possible, and a 3-stream smoke run pays for three sign-ins, not twelve.
  const emails = [...DEMO_ACCOUNTS.mentee, ...DEMO_ACCOUNTS.mentor, ...DEMO_ACCOUNTS.admin].slice(0, CONNECTIONS);
  for (const email of emails) {
    const c = signIn(BASE_URL, email, { ep: 'auth' });
    if (c) cookies.push(c);
  }
  if (!cookies.length) throw new Error('demo sign-in failed for every account — is the demo seeded?');
  return { cookies };
}

export default function (data) {
  // Round-robin over accounts so no one user passes the per-user stream cap.
  const cookie = data.cookies[(__VU - 1) % data.cookies.length];
  const res = http.get(`${BASE_URL}/api/realtime/stream?maxSeconds=${HOLD_SECONDS}`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    tags: { ep: 'sse_stream' },
    timeout: `${HOLD_SECONDS + 30}s`,
    responseType: 'text',
  });
  const body = typeof res.body === 'string' ? res.body : '';
  check(res, { 'sse_stream → 200': (r) => r.status === 200 });
  ready.add(/^event: ready$/m.test(body));
  const pings = [...body.matchAll(/^: ping (\d+)$/gm)].map((m) => Number(m[1]));
  for (let i = 1; i < pings.length; i++) {
    drift.add(Math.abs(pings[i] - pings[i - 1] - HEARTBEAT_MS));
    beats.add(1);
  }
}

function ms(v) {
  return v === undefined ? '   —  ' : `${Math.round(v)}ms`.padStart(7);
}

export function handleSummary(data) {
  const m = data.metrics || {};
  const wait = m['http_req_waiting{ep:sse_stream}']?.values || {};
  const d = m.sse_heartbeat_drift_ms?.values || {};
  const out = [
    '',
    `  target:       ${BASE_URL}`,
    `  streams:      ${CONNECTIONS} concurrent, held ${HOLD_SECONDS}s`,
    `  setup (TTFB): p95=${ms(wait['p(95)'])} max=${ms(wait.max)}`,
    `  ready rate:   ${(((m.sse_ready?.values?.rate ?? 0) * 100)).toFixed(1)}%`,
    `  beat drift:   p95=${ms(d['p(95)'])} max=${ms(d.max)} over ${m.sse_heartbeat_intervals?.values?.count ?? 0} intervals`,
    '',
  ];
  const breaches = [];
  for (const [name, metric] of Object.entries(m)) {
    for (const [expr, result] of Object.entries(metric.thresholds || {})) {
      const ok = typeof result === 'object' && result !== null ? result.ok : result;
      if (ok === false) breaches.push(`${name}: ${expr}`);
    }
  }
  out.push(breaches.length ? `  ✖ ${breaches.length} threshold(s) breached:\n${breaches.map((b) => `      - ${b}`).join('\n')}` : '  ✔ all thresholds within limits');
  out.push('');
  return { [SUMMARY_FILE]: JSON.stringify(data, null, 2), stdout: out.join('\n') };
}
