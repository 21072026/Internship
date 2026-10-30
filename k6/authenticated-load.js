/**
 * Authenticated load test — the demo environment ONLY (#1612).
 *
 * k6/nightly-load.js is anonymous-GET-only by hard rule, so every signed-in
 * screen and every write path was untested under load. This scenario covers
 * them, against the one environment where signing in and writing rows is
 * harmless: the public demo (its own database, published credentials, wiped
 * twice a day by demo-reset.yml — docs/DEMO.md).
 *
 * SAFETY — hard constraints, not preferences:
 *   - setup() refuses any host that is not the demo (k6/lib/demoTarget.js); a
 *     reflexive run cannot reach production or the shared preview.
 *   - Sign-ins happen in setup() only: one per demo account (12 bcrypt
 *     comparisons), measured as the `auth` phase. VUs reuse the cookies.
 *   - Writes are only ones the demo permits (DEMO_BLOCKED_WRITES in
 *     src/lib/demoMode.ts does not cover them): a mentor posting a message in a
 *     mentorship thread and a mentor logging an interaction. Demo mode skips
 *     all mail, so neither reaches an inbox.
 *   - POST /api/messages is rate-limited to 60/min per IP and every VU shares
 *     the runner's IP, so the message write runs on an ARRIVAL RATE capped at
 *     30/min — half the bucket. A 429 here means this cap drifted, not that the
 *     app is sick. /api/public/stats and /api/v1/* stay out entirely.
 *   - Every request is tagged { ep } and every tag has a duration budget and a
 *     `count>0` line (the alert email's table is built from exactly those).
 *
 * Run it:
 *   k6 run k6/authenticated-load.js                          # full run vs demo
 *   K6_SMOKE=1 K6_PEAK_VUS=3 k6 run k6/authenticated-load.js # < 1 min script check
 *   BASE_URL=http://localhost:3000 K6_ALLOW_LOCAL=1 K6_SMOKE=1 k6 run k6/authenticated-load.js
 *     (local dev server after `npm run seed:demo`)
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { assertDemoTarget, baseUrl, DEMO_ACCOUNTS, signIn } from './lib/demoTarget.js';

function numEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const BASE_URL = baseUrl();
// Clamped for the same reason as nightly-load.js: a typo must not become 2000 VUs.
const PEAK_VUS = Math.min(30, Math.max(1, Math.round(numEnv('K6_PEAK_VUS', 10))));
const SUMMARY_FILE = __ENV.K6_SUMMARY_FILE || 'k6-auth-summary.json';
const SMOKE = __ENV.K6_SMOKE === '1';

const step = (f) => Math.max(1, Math.round(PEAK_VUS * f));
const READ_STAGES = SMOKE
  ? [
      { duration: '10s', target: PEAK_VUS },
      { duration: '25s', target: PEAK_VUS },
      { duration: '5s', target: 0 },
    ]
  : [
      { duration: '30s', target: step(0.3) },
      { duration: '1m30s', target: step(0.3) },
      { duration: '30s', target: PEAK_VUS },
      { duration: '2m', target: PEAK_VUS },
      { duration: '30s', target: 0 },
    ];
const WRITE_DURATION = SMOKE ? '40s' : '5m';

const thresholds = {
  // Aggregates. Same 2% error budget as the anonymous test; authenticated pages
  // do real per-user queries, so p95 gets more room than the anonymous 2500ms.
  http_req_failed: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: SMOKE ? '30s' : '2m' }],
  http_req_duration: ['p(95)<3000', 'p(99)<6000'],
  checks: ['rate>0.98'],

  // auth — csrf + credentials callback, one per demo account in setup(). The
  // callback is a bcrypt comparison by design (cost 10–12), so it is budgeted as
  // slow on purpose; what this catches is it getting *much* slower.
  'http_req_duration{ep:auth}': ['p(95)<2500'],
  'http_reqs{ep:auth}': ['count>0'],

  // read — the signed-in screens the anonymous test cannot reach.
  'http_req_duration{ep:portal}': ['p(95)<2500'],
  'http_reqs{ep:portal}': ['count>0'],
  'http_req_duration{ep:mentor_home}': ['p(95)<2500'],
  'http_reqs{ep:mentor_home}': ['count>0'],
  'http_req_duration{ep:messages_page}': ['p(95)<2500'],
  'http_reqs{ep:messages_page}': ['count>0'],
  'http_req_duration{ep:admin_board}': ['p(95)<3000'],
  'http_reqs{ep:admin_board}': ['count>0'],
  // The JSON the mentor screens are built from.
  'http_req_duration{ep:relations_api}': ['p(95)<1500'],
  'http_reqs{ep:relations_api}': ['count>0'],

  // write — what a busy cohort day actually does.
  'http_req_duration{ep:message_post}': ['p(95)<1500'],
  'http_req_failed{ep:message_post}': ['rate<0.02'],
  'http_reqs{ep:message_post}': ['count>0'],
  'http_req_duration{ep:interaction_post}': ['p(95)<1500'],
  'http_req_failed{ep:interaction_post}': ['rate<0.02'],
  'http_reqs{ep:interaction_post}': ['count>0'],
};

export const options = {
  discardResponseBodies: true,
  userAgent: 'internship-crm-k6/1.0 (+authenticated demo load test; github actions)',
  maxRedirects: 0,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds,
  // setup() signs in 12 accounts; give it room on a cold container.
  setupTimeout: '2m',
  scenarios: {
    read: {
      executor: 'ramping-vus',
      exec: 'read',
      startVUs: 0,
      gracefulRampDown: '10s',
      gracefulStop: '15s',
      stages: READ_STAGES,
    },
    // Half the per-IP message bucket (60/min): 1 every 2s.
    messages: {
      executor: 'constant-arrival-rate',
      exec: 'postMessage',
      rate: 1,
      timeUnit: '2s',
      duration: WRITE_DURATION,
      preAllocatedVUs: 2,
      maxVUs: 4,
    },
    interactions: {
      executor: 'constant-arrival-rate',
      exec: 'logInteraction',
      rate: 1,
      timeUnit: '3s',
      duration: WRITE_DURATION,
      preAllocatedVUs: 2,
      maxVUs: 4,
    },
  },
};

const auth = { tags: { ep: 'auth' } };

export function setup() {
  assertDemoTarget(BASE_URL);
  const sessions = { admin: [], mentor: [], mentee: [] };
  for (const role of Object.keys(DEMO_ACCOUNTS)) {
    for (const email of DEMO_ACCOUNTS[role]) {
      const cookie = signIn(BASE_URL, email, auth.tags);
      if (cookie) sessions[role].push(cookie);
    }
  }
  if (!sessions.admin.length || !sessions.mentor.length || !sessions.mentee.length) {
    throw new Error(
      `demo sign-in failed (admin ${sessions.admin.length}, mentors ${sessions.mentor.length}, mentees ${sessions.mentee.length}) — is the demo seeded?`
    );
  }
  // Every (mentor, relation) pair the write phase may post to.
  const threads = [];
  for (const cookie of sessions.mentor) {
    const res = http.get(`${BASE_URL}/api/mentorship`, {
      headers: { Cookie: cookie },
      tags: { ep: 'relations_api' },
      responseType: 'text',
    });
    try {
      for (const r of JSON.parse(res.body).relations || []) if (r.id) threads.push({ cookie, relationId: r.id });
    } catch {
      /* counted by the empty check below */
    }
  }
  if (!threads.length) throw new Error('no demo mentor has a mentorship relation — is the demo seeded?');
  return { sessions, threads };
}

function get(path, ep, cookie) {
  const res = http.get(`${BASE_URL}${path}`, { headers: { Cookie: cookie }, tags: { ep } });
  check(res, { [`${ep} → 200`]: (r) => r.status === 200 });
}

const pick = (list, n) => list[n % list.length];
const think = () => sleep(1 + Math.random() * 2);

// A mixed browsing population: three mentee iterations, one mentor, one admin
// in every five. Offset by VU so even a 3-VU smoke run reaches every screen.
export function read(data) {
  const s = data.sessions;
  const roll = (__VU + __ITER) % 5;
  if (roll < 3) {
    const c = pick(s.mentee, __VU);
    get('/portal', 'portal', c);
    think();
    get('/messages', 'messages_page', c);
  } else if (roll === 3) {
    const c = pick(s.mentor, __VU);
    get('/mentor', 'mentor_home', c);
    think();
    get('/api/mentorship', 'relations_api', c);
  } else {
    get('/admin/board', 'admin_board', pick(s.admin, __VU));
  }
  think();
}


export function postMessage(data) {
  const { cookie, relationId } = pick(data.threads, __ITER);
  const res = http.post(
    `${BASE_URL}/api/messages`,
    JSON.stringify({ relationId, body: `k6 load test message ${__ITER} — demo only, wiped by the next demo reset.` }),
    { headers: { Cookie: cookie, 'Content-Type': 'application/json' }, tags: { ep: 'message_post' } }
  );
  check(res, { 'message_post → 2xx': (r) => r.status >= 200 && r.status < 300 });
}

export function logInteraction(data) {
  const { cookie, relationId } = pick(data.threads, __ITER + 1);
  const res = http.post(
    `${BASE_URL}/api/interactions`,
    JSON.stringify({
      relationId,
      date: new Date().toISOString(),
      type: 'Feedback',
      subject: 'k6 load test',
      notes: 'Logged by the authenticated k6 scenario on the demo environment; wiped by the next demo reset.',
    }),
    { headers: { Cookie: cookie, 'Content-Type': 'application/json' }, tags: { ep: 'interaction_post' } }
  );
  check(res, { 'interaction_post → 2xx': (r) => r.status >= 200 && r.status < 300 });
}

// ── Summary — the same shape nightly-load.js writes, for scripts/k6-report-email.mjs.
function ms(v) {
  return v === undefined ? '   —  ' : `${Math.round(v)}ms`.padStart(7);
}

export function handleSummary(data) {
  const m = data.metrics || {};
  const dur = m.http_req_duration?.values || {};
  const out = [
    '',
    `  target:     ${BASE_URL}`,
    `  peak VUs:   ${PEAK_VUS} (read) + arrival-rate writes`,
    `  requests:   ${m.http_reqs?.values?.count ?? 0}  (${((m.http_req_failed?.values?.rate ?? 0) * 100).toFixed(2)}% failed)`,
    `  latency:    avg=${ms(dur.avg)} p95=${ms(dur['p(95)'])} p99=${ms(dur['p(99)'])} max=${ms(dur.max)}`,
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
