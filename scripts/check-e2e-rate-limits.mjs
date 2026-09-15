#!/usr/bin/env node
/**
 * Does the e2e suite spend more of a rate-limit bucket than the bucket holds?
 *
 * WHY THIS EXISTS (#2158, #2159). `enforceRateLimit` keys on `bucket:ip` into a
 * PER-PROCESS store, and a full-suite shard runs its whole file list against ONE
 * Next server (`workers: 1`, one `webServer`). Every request that arrives
 * without a usable client address counts into the same `<bucket>:unknown`
 * counter — so the suite's calls to one endpoint are cumulative across specs,
 * and the windows here are 10-60 minutes, i.e. longer than a shard.
 *
 * That is not a theory: `rate-limit.spec.ts`'s six POSTs to `/api/support`
 * (limit 5) left `support-attachments.spec.ts` and `support-chat.spec.ts` with
 * nothing to spend and pinned shard 4/4 of e2e-full red, and the same shape hit
 * `mentor-application` and `apply`. Each was diagnosed from a red scheduled run,
 * hours after the merge that tipped it over. This check moves that to the PR.
 *
 * THE RULE. For every bucket, count the e2e call sites that spend it without
 * opting out. A spec opts out with `freshIp()` (a new synthetic address per
 * call) or pins itself with `floodIp()` (a stable one), both from
 * `e2e/helpers/rateLimit.ts` — either way the request no longer touches
 * `<bucket>:unknown`. When what is left reaches the bucket's limit, the suite
 * can exhaust it and this fails.
 *
 * WHAT IT CANNOT SEE, stated plainly so nobody reads a pass as a proof:
 * requests the BROWSER makes (a form submit, a fetch from a component) carry no
 * literal URL in the spec, so the count is a floor, not a ceiling. A spec that
 * drives a rate-limited endpoint through the UI isolates itself with
 * `page.setExtraHTTPHeaders(freshIp(…))` or a context `extraHTTPHeaders`, and
 * that is a review matter, not something this script can enforce.
 *
 * The limits are read out of the route files rather than restated here, so
 * lowering a limit in the app is what surfaces the specs that no longer fit.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const API_DIR = 'src/app/api';
const E2E_DIR = 'e2e';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ── 1. Every bucket the app enforces, with its limit and its route path ──────
//
// `enforceRateLimit(request, 'bucket', { limit: N, windowMs: … })`, tolerating
// the call being spread over several lines (most of the AI ones are).
const CALL = /enforceRateLimit\(\s*[A-Za-z_$][\w$]*\s*,\s*(['"`])([^'"`]+)\1\s*,\s*\{([^}]*)\}/g;

const buckets = new Map(); // bucket -> { limit, routes:Set }
for (const file of walk(API_DIR).filter((f) => f.endsWith('route.ts'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(CALL)) {
    const name = m[2];
    // A templated bucket (`invite-bulk:${session.user.id}`) is keyed per user,
    // not per IP, so the suite cannot pile into one counter.
    if (name.includes('${')) continue;
    // `subject:` keys the counter on something other than the IP — a user id,
    // an org — so the suite's specs, each seeding its own user, cannot pile
    // into one counter and the budget below does not apply.
    if (/\bsubject:/.test(m[3])) continue;
    const limit = /limit:\s*(\d+)/.exec(m[3]);
    const windowMs = /windowMs:\s*([\d*\s_]+)/.exec(m[3]);
    if (!limit || !windowMs) continue;
    // eslint-disable-next-line no-eval -- the captured text is an arithmetic
    // literal from our own source (`15 * 60 * 1000`), matched by the regex above.
    const ms = Function(`return (${windowMs[1]})`)();
    const route = '/api/' + path.dirname(path.relative(API_DIR, file)).replaceAll(path.sep, '/');
    const seen = buckets.get(name) || { limit: Infinity, windowMs: Infinity, routes: new Set() };
    seen.limit = Math.min(seen.limit, Number(limit[1]));
    seen.windowMs = Math.min(seen.windowMs, ms);
    seen.routes.add(route);
    buckets.set(name, seen);
  }
}

if (!buckets.size) {
  console.error('no rate-limited routes found — the parser is broken, not the app');
  process.exit(1);
}

// A route path becomes a matcher: dynamic segments accept anything but a slash,
// and a query string or trailing path is allowed (`/api/rsvp?token=…`).
function matcher(route) {
  const body = route
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith('[') ? '[^/\'"`?\\s]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`['"\`](?:https?://[^'"\`]*)?/${body}(?:[?'"\`]|$)`);
}

// ── 2. Every e2e call site that spends one ──────────────────────────────────
//
// Only the verbs that consume a bucket: `enforceRateLimit` runs before the
// handler body, so a GET counts too when the route limits GETs — but the
// buckets that bite are the write ones, and counting every `page.goto` would
// drown the signal in navigations that are not requests to the API at all.
const VERB = /\.(post|put|patch|delete|fetch)\s*\(/;
const ISOLATED = /\b(freshIp|floodIp)\s*\(/;

const specs = walk(E2E_DIR).filter((f) => f.endsWith('.ts'));
const spend = new Map(); // bucket -> [{file, line, text}]

for (const file of specs) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!VERB.test(line)) return;
    for (const [name, { routes }] of buckets) {
      if (![...routes].some((r) => matcher(r).test(line))) continue;
      // The isolation header may sit on the call's own line or a few lines
      // below it, inside the options object.
      const window = lines.slice(i, i + 12).join('\n');
      if (ISOLATED.test(window)) continue;
      (spend.get(name) || spend.set(name, []).get(name)).push({
        file,
        line: i + 1,
        text: line.trim().slice(0, 100),
      });
    }
  });
}

// ── 3. Verdict ──────────────────────────────────────────────────────────────
//
// How the calls are counted depends on the window, because that is what decides
// whether the suite's calls can land inside one:
//
// - A LONG window (>= 5 min) outlives the shard's walk through its file list,
//   so every call site in the suite counts into the same one.
// - A SHORT window only catches a burst, so the budget is per spec FILE — a
//   `meetings/[id]` PATCH in a spec that ran three minutes ago cannot throttle
//   this one.
const LONG_WINDOW_MS = 5 * 60 * 1000;

function budgets(name, sites) {
  const { windowMs } = buckets.get(name);
  if (windowMs >= LONG_WINDOW_MS) return [{ scope: 'the suite', sites }];
  const byFile = new Map();
  for (const s of sites) (byFile.get(s.file) || byFile.set(s.file, []).get(s.file)).push(s);
  return [...byFile].map(([file, group]) => ({ scope: file, sites: group }));
}

const failures = [];
const near = [];
for (const [name, sites] of spend) {
  const { limit } = buckets.get(name);
  for (const budget of budgets(name, sites)) {
    if (budget.sites.length >= limit) failures.push({ name, limit, ...budget });
    else if (budget.sites.length >= Math.ceil(limit * 0.7)) near.push({ name, limit, ...budget });
  }
}

if (failures.length) {
  console.error('e2e rate-limit budget exceeded — the suite can exhaust these buckets:\n');
  for (const { name, limit, scope, sites } of failures.sort((a, b) => b.sites.length - a.sites.length)) {
    console.error(`  ${name}: ${sites.length} unisolated call site(s) in ${scope}, limit ${limit}`);
    for (const s of sites) console.error(`      ${s.file}:${s.line}  ${s.text}`);
    console.error('');
  }
  console.error(
    'Every request without a client address counts into one `<bucket>:unknown` counter for\n' +
      'the whole shard. Give the spec its own address: `freshIp(label)` when it merely has to\n' +
      'get past the brake to reach the feature, `floodIp(label)` when it is measuring the brake\n' +
      'and must spend one counter repeatedly. Both live in e2e/helpers/rateLimit.ts.'
  );
  process.exit(1);
}

const spent = [...spend.values()].reduce((n, s) => n + s.length, 0);
console.log(
  `e2e rate limits OK — ${buckets.size} IP-keyed bucket(s) enforced by the app, ` +
    `${spent} unisolated call site(s) in the suite, none within a bucket's limit.`
);
// Not a failure, but the next spec to touch one of these tips it over, and the
// report would then arrive as a red scheduled run rather than as this line.
for (const { name, limit, scope, sites } of near.sort((a, b) => b.sites.length / b.limit - a.sites.length / a.limit)) {
  console.log(`  close: ${name} ${sites.length}/${limit} in ${scope}`);
}
