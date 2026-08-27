/**
 * Nightly load test — Internship CRM.
 *
 * WHAT THIS IS. A k6 scenario that walks the public, read-only surface of a
 * *deployed* environment under a staged VU ramp for ~6 minutes, and fails the
 * run when latency, error rate or per-endpoint budgets leave their limits. It is
 * the non-functional counterpart to the Playwright suite: the app can be
 * perfectly correct and still be too slow, and only this catches that.
 *
 * WHY BOTH THIS AND scripts/stress-test.mjs. `stress-test.mjs` is a flat
 * hammer — fixed concurrency, one aggregate p95, weekly. This adds what a flat
 * hammer cannot express: a *ramp* (does latency degrade as load grows, or only
 * at peak?), *per-endpoint* budgets (the landing page and a JSON probe should
 * not share one number), and a threshold engine that names exactly which budget
 * broke. The two are complementary; neither replaces the other.
 *
 * SAFE AGAINST PRODUCTION — this is a hard constraint, not a preference:
 *   - GET only. No POST/PUT/PATCH/DELETE, ever. Nothing here mutates a row.
 *   - No authentication. No login (bcrypt is deliberately expensive and the
 *     failed-login bucket would lock the runner's IP out), no session cookie,
 *     no API key. Everything below is reachable by an anonymous visitor.
 *   - No endpoint that sends email, calls an AI provider, polls IMAP, talks to
 *     Google/JaaS, or increments a counter (so: never /api/profile-view).
 *   - No rate-limited route. All k6 VUs share ONE source IP (the GitHub
 *     runner), so they share one rate-limit bucket — /api/public/stats
 *     (60 / 10 min) and /api/v1/* (120 / min) are excluded on purpose. A 429
 *     in a report means this mix drifted, not that the app is unhealthy.
 *   - Peak 20 VU ≈ 10 req/s, below the 25 concurrent that stress.yml has run
 *     against production since 2026-07. What k6 adds is *duration*, not depth.
 *
 * ADDING A NEW k6 TEST: see the "Load / performance test (k6)" section of
 * docs/testing.md. Short version: new `k6/<name>.js`, keep it `.js` (`.ts` here
 * is pulled into `npx tsc --noEmit` and fails on the missing `k6/*` module
 * types — deliberately, so the rule enforces itself), tag every request
 * `{ ep: '<name>' }`, give each tag its own threshold, and stay inside the
 * safety rules above. Nothing in this directory is linted or typechecked, so
 * `npm run check:k6` (a `k6 archive` parse) is what CI has to catch a typo.
 *
 * Run it locally (needs the k6 binary — it is not an npm dependency):
 *   BASE_URL=https://crm-preview.ersah.in k6 run k6/nightly-load.js
 *   npm run test:load                          # the full ~6m ramp against preview
 *   K6_SMOKE=1 K6_PEAK_VUS=3 npm run test:load # ~40s: "does my script still work"
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

// ── Configuration (env, with defaults that are safe to run unattended) ───────
function numEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Preview, NOT production, is the default: `npm run test:load` is a command a
// contributor can run by reflex, and it must not put a six-minute ramp on the
// live site because they forgot to set BASE_URL. The nightly workflow always
// passes its own target explicitly, so it is unaffected by this default.
const BASE_URL = (__ENV.BASE_URL || 'https://crm-preview.ersah.in').replace(/\/+$/, '');
// Clamped, because the file's whole safety argument rests on "modest load" and
// the workflow forwards a free-text `peak_vus` dispatch input straight through.
// A typo of 2000 must not become 2000 VUs against a shared environment.
const PEAK_VUS = Math.min(50, Math.max(1, Math.round(numEnv('K6_PEAK_VUS', 20))));
const SUMMARY_FILE = __ENV.K6_SUMMARY_FILE || 'k6-summary.json';
// K6_SMOKE=1 collapses the ramp to ~40s. It exists so a change to this file can
// be validated in under a minute — nobody re-runs a six-minute ramp to find out
// they mistyped a threshold name. It is a script check, NOT a load measurement:
// the thresholds still apply, but the sample is far too small to judge an
// environment by. The nightly workflow never sets it.
const SMOKE = __ENV.K6_SMOKE === '1';

// Intermediate ramp steps scale with the peak so K6_PEAK_VUS=3 still produces a
// real ramp (and not three identical stages) when smoke-testing the script.
const step = (fraction) => Math.max(1, Math.round(PEAK_VUS * fraction));

const RAMP = SMOKE
  ? [
      { duration: '10s', target: PEAK_VUS },
      { duration: '20s', target: PEAK_VUS },
      { duration: '10s', target: 0 },
    ]
  : [
      { duration: '30s', target: step(0.25) }, // warm up
      { duration: '1m', target: step(0.25) }, //  baseline plateau
      { duration: '30s', target: step(0.75) },
      { duration: '2m', target: step(0.75) }, //  sustained mid load
      { duration: '30s', target: PEAK_VUS },
      { duration: '1m', target: PEAK_VUS }, //    peak plateau
      { duration: '30s', target: 0 }, //          ramp down
    ];

// ── Thresholds ───────────────────────────────────────────────────────────────
// Every number below is a budget someone has to defend, so each carries its
// reasoning. The two aggregate limits deliberately match the ones production
// has been held to since stress.yml shipped (2% errors, p95 2500ms) — a new
// tool should not quietly move a bar the maintainer already calibrated.
//
// Per-endpoint budgets are tighter than the aggregate because they are allowed
// to be: /auth/signin runs zero Prisma queries, so holding it to the same
// 2500ms as the landing page would make it untestable. A tagged sub-metric only
// appears in the JSON summary when a threshold references it — which is also
// why each endpoint gets a `http_reqs{ep:…}: count>0` line: it asserts the
// endpoint was actually exercised (a path that silently drops out of the mix
// would otherwise look green) and it materialises the per-endpoint request
// count for the alert email's table.
const thresholds = {
  // Aggregate error rate. Same 2% as STRESS_MAX_ERROR_RATE in stress.yml.
  // abortOnFail stops the run early when the target is genuinely down. The
  // 3-minute delay is not politeness, it is arithmetic: the rate is cumulative,
  // so at t=1m only ~150 requests have accumulated and *four* failures would
  // already cross 2% and kill the run — reporting eight "breached" per-endpoint
  // budgets computed from a handful of samples. By t=3m the denominator is
  // ~1000 and the rate means something.
  http_req_failed: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '3m' }],
  // Aggregate latency. p95 mirrors STRESS_MAX_P95_MS; p99 gets 2× headroom so
  // it flags a fat tail without firing on a single slow outlier.
  http_req_duration: ['p(95)<2500', 'p(99)<5000'],
  // Time-to-first-byte isolates server think-time from transfer, so a slow
  // network path between the runner and the box cannot read as a slow app.
  http_req_waiting: ['p(95)<2000'],
  // Wrong status codes (a redirect where a 200 is expected, a 503). Exactly one
  // check runs per request, so this rate is ~1 minus the error rate — set it to
  // 0.98 rather than 0.99, or it would quietly override the 2% error budget
  // above with a 1% one and fire first on every marginal night.
  checks: ['rate>0.98'],

  // /api/health, anonymous. NOTE: when HEALTH_TOKEN is unset on the server the
  // endpoint answers *everyone* with the detailed payload, which costs four
  // EmailLog queries (src/lib/emailHealth.ts). 800ms is budgeted for that
  // worse case; set HEALTH_TOKEN on the server and this drops to ~50ms.
  'http_req_duration{ep:health}': ['p(95)<800'],
  // The liveness probe failing is an outage, not a slow night — so this is the
  // tightest error budget in the file. Not tighter, though: a full run makes
  // ~220 health requests, so rate<0.005 would mean "at most ONE failed probe
  // all night" and two unrelated blips would mail the maintainer. 1% allows two.
  'http_req_failed{ep:health}': ['rate<0.01'],
  'http_reqs{ep:health}': ['count>0'],

  // /api/health?db=1 — the above plus a `SELECT 1` round-trip to MySQL.
  'http_req_duration{ep:health_db}': ['p(95)<1000'],
  'http_req_failed{ep:health_db}': ['rate<0.02'],
  'http_reqs{ep:health_db}': ['count>0'],

  // "/" — the heaviest safe GET: server-rendered, reads published stories and
  // the (10-min cached) public stats. It is also the page every visitor lands
  // on, so it gets the most generous budget of the pages and matters the most.
  'http_req_duration{ep:landing}': ['p(95)<2000'],
  'http_req_failed{ep:landing}': ['rate<0.02'],
  'http_reqs{ep:landing}': ['count>0'],

  // /auth/signin — server-rendered, zero Prisma. If this is slow, the Node
  // process itself is saturated, which is exactly what we want to learn.
  'http_req_duration{ep:signin}': ['p(95)<1500'],
  'http_req_failed{ep:signin}': ['rate<0.02'],
  'http_reqs{ep:signin}': ['count>0'],

  // /features — rendered from the in-process feature catalogue, no DB.
  'http_req_duration{ep:features}': ['p(95)<1500'],
  'http_req_failed{ep:features}': ['rate<0.02'],
  'http_reqs{ep:features}': ['count>0'],

  // /api/public/stories — small JSON, one Prisma read, s-maxage=300.
  'http_req_duration{ep:stories_api}': ['p(95)<1200'],
  'http_req_failed{ep:stories_api}': ['rate<0.02'],
  'http_reqs{ep:stories_api}': ['count>0'],
};

export const options = {
  // Bodies are never inspected, only status codes — dropping them keeps the
  // runner's memory flat and stops transfer time from dominating the latency.
  discardResponseBodies: true,
  // An honest, stable UA: the edge should see one identifiable client, not
  // something that looks like a scraper worth challenging.
  userAgent: 'internship-crm-k6/1.0 (+nightly load test; github actions)',
  // Zero, not one. A redirect where a 200 is expected is a finding, and the
  // redirects that actually happen in the wild (locale, trailing slash,
  // http→https) are single-hop — following "just one" would swallow exactly the
  // case this is meant to catch, and fold the extra hop into the ep's latency
  // budget on top. k6 returns the 3xx as res.status rather than erroring, so
  // the status check below turns it red.
  maxRedirects: 0,
  insecureSkipTLSVerify: false,
  // p(99) is not in k6's default trend stats; the alert email reads it.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds,
  scenarios: {
    // A ramp, not a step: the interesting question is *where* latency starts
    // to bend, and a flat load cannot answer it. Stages sum to 6m00s.
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      gracefulRampDown: '15s',
      gracefulStop: '20s',
      // No maxDuration here — `ramping-vus` rejects it (it belongs to the
      // arrival-rate / per-vu-iterations executors). The stages bound the run,
      // gracefulStop bounds the tail, and the workflow's timeout-minutes: 15 is
      // the outer backstop against a pathologically slow target.
      stages: RAMP,
    },
  },
};

// ── The request mix ──────────────────────────────────────────────────────────
// Weighted by how often a real visitor hits each path, and deliberately keeping
// the DB-backed probes rare: at peak this is ~10 req/s in total, of which the
// four-query /api/health path is roughly a quarter.
function hit(path, ep, expect) {
  const res = http.get(`${BASE_URL}${path}`, { tags: { ep } });
  check(res, { [`${ep} → ${expect}`]: (r) => r.status === expect });
  return res;
}

// Think time between requests. Randomised so VUs that started together do not
// stay in lockstep and arrive as a synchronised burst every few seconds.
function think() {
  sleep(1 + Math.random() * 2);
}

export default function () {
  const i = __ITER;

  hit('/', 'landing', 200);
  think();

  if (i % 2 === 0) {
    hit('/auth/signin', 'signin', 200);
    think();
  }
  if (i % 3 === 0) {
    hit('/features', 'features', 200);
    think();
  }
  if (i % 3 === 1) {
    hit('/api/public/stories', 'stories_api', 200);
    think();
  }
  if (i % 4 === 0) {
    // Pure liveness. Note what this does NOT prove: without ?db=1 the route
    // leaves `db` and `smtp` at 'skipped', so it answers 200 in every state
    // short of the process being down (src/app/api/health/route.ts). The DB
    // half is covered by the health_db probe below; SMTP is not covered here
    // at all (the e2e suite and /api/admin/email-health own that).
    hit('/api/health', 'health', 200);
    think();
  }
  // The rarest probe, but still every sixth iteration: its `count>0` threshold
  // is a real assertion that the endpoint was exercised, and a run too short to
  // reach it (a K6_SMOKE=1 check, say) will legitimately go red on that line.
  if (i % 6 === 5) {
    hit('/api/health?db=1', 'health_db', 200);
    think();
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
// handleSummary runs even when a threshold failed (and when abortOnFail cut the
// run short), so the JSON below always exists for the alert email to read —
// which is why the email's verdict comes from this file rather than from k6's
// exit code. The text rendering is hand-rolled rather than imported from
// jslib.k6.io: that import is a network fetch at script load, and a load test
// that cannot start because a CDN is down is worse than a plainer report.
function ms(v) {
  return v === undefined ? '   —  ' : `${Math.round(v)}ms`.padStart(7);
}

function renderText(data) {
  const m = data.metrics || {};
  const out = [];
  const reqs = m.http_reqs?.values?.count ?? 0;
  const failRate = m.http_req_failed?.values?.rate ?? 0;
  const dur = m.http_req_duration?.values || {};

  out.push('');
  out.push(`  target:     ${BASE_URL}`);
  out.push(`  peak VUs:   ${PEAK_VUS}`);
  out.push(`  requests:   ${reqs}  (${(failRate * 100).toFixed(2)}% failed)`);
  out.push(
    `  latency:    avg=${ms(dur.avg)} p95=${ms(dur['p(95)'])} p99=${ms(dur['p(99)'])} max=${ms(dur.max)}`
  );
  out.push('');

  const breaches = [];
  for (const [name, metric] of Object.entries(m)) {
    for (const [expr, result] of Object.entries(metric.thresholds || {})) {
      // k6 reports `{ ok: boolean }`; older builds used a bare boolean.
      const ok = typeof result === 'object' && result !== null ? result.ok : result;
      if (ok === false) breaches.push(`${name}: ${expr}`);
    }
  }
  if (breaches.length === 0) {
    out.push('  ✔ all thresholds within limits');
  } else {
    out.push(`  ✖ ${breaches.length} threshold(s) breached:`);
    for (const b of breaches) out.push(`      - ${b}`);
  }
  out.push('');
  return out.join('\n');
}

export function handleSummary(data) {
  return {
    [SUMMARY_FILE]: JSON.stringify(data, null, 2),
    stdout: renderText(data),
  };
}
