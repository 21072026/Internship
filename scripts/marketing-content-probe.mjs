#!/usr/bin/env node
// Content probe for the marketing hosts (#2579, brand-free since #2919).
//
// WHY THIS EXISTS
//   `/api/health` answers the same JSON on every host a container serves, so the
//   uptime check stays green when a marketing host is up but shows the WRONG
//   PRODUCT. That is not hypothetical: an empty `MARKETING_HOSTS` made the prod
//   marketing domain serve the internship landing until #2428 (2026-09-21), and
//   nothing noticed until someone looked.
//
// THE RULE
//   A marketing host names its product twice: in the document `<title>` and in
//   the `name` of its own `/manifest.webmanifest`. Both come from the same
//   place, so on a correctly configured host they agree. A page is right when
//     - its `<title>` does not say "Internship CRM" (the wrong product),
//     - its host's manifest has a `name`, and that name is neither the
//       internship product nor the neutral fallback "coreCRM" (which means the
//       host's brand is missing),
//     - and its `<title>` contains that name.
//   No brand is written down here: the host says what it is called, and the
//   probe checks that it agrees with itself and is not the wrong product.
//   infra/deploy-prod.sh and infra/server/topic-deploy.sh run the same rule in
//   shell after every deploy; infra/test/marketing-title-check.test.sh holds
//   the copies together.
//
// WHAT IT NEVER PRINTS
//   The targets come from a secret (MARKETING_PROBE_URLS), and everything this
//   script writes lands in a public run log, an issue body and a mail. So no
//   line carries a URL, a hostname, a title or a manifest name. A target is
//   named by position — `marketing host #<h>, page #<p>` — and a finding by a
//   fixed reason. `<p>` is the target's place in the list; `<h>` is the place of
//   its origin among the list's distinct origins, in order (hostNumbers()).
//   uptime.yml numbers its reachability probe of the same hosts the same way,
//   which is how a content finding on a host that is down gets dropped.
//
// CONTRACT (what .github/workflows/uptime.yml relies on)
//   - Every failing target prints ONE line on stdout:
//     `marketing host #<h>, page #<p> -> <reason>`. Those lines are the
//     alert's detail, verbatim.
//   - Green prints nothing on stdout and exits 0. An `OK` / `FAIL` line per
//     target goes to stderr, which the run log shows and the alert never reads.
//   - Any failure exits 1. A usage error (no targets) exits 2, so a broken
//     workflow edit cannot pass as "nothing to check".
//
// Plain ESM with no dependency on purpose: the uptime job runs this from a
// sparse checkout with no `npm ci`, on whatever Node the hosted runner ships.
//
// USAGE
//   MARKETING_PROBE_URLS="https://<host>/ https://<host>/imprint" node scripts/marketing-content-probe.mjs
//   node scripts/marketing-content-probe.mjs https://<host>/ …
//   Tests: node --test scripts/test/marketing-content-probe.test.mjs

import { pathToFileURL } from 'node:url';

export const INTERNSHIP_NAME = 'Internship CRM';
export const FALLBACK_NAME = 'coreCRM';
export const TIMEOUT_MS = 20_000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

// Whitespace collapsed and lower-cased: what "contains" compares.
const fold = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// The document title, or null when the page has none. An inline `<svg>` may
// carry its own `<title>` (an icon's accessible name) — that is not the
// document's, so SVG blocks are dropped before looking.
export function extractTitle(html) {
  if (typeof html !== 'string') return null;
  const withoutSvg = html.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  const m = withoutSvg.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return title || null;
}

// The manifest's top-level `name`, or null when the body is not a JSON object
// with a non-blank string name.
export function manifestName(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const name = parsed && typeof parsed === 'object' ? parsed.name : null;
  if (typeof name !== 'string') return null;
  const trimmed = name.replace(/\s+/g, ' ').trim();
  return trimmed || null;
}

// Pure verdict on one page: null when it is right, otherwise a fixed reason.
// A reason never quotes the title or the name — see WHAT IT NEVER PRINTS.
export function judge(title, name) {
  if (title == null || !title.trim()) return 'no <title> in the page';
  const t = fold(title);
  if (t.includes(fold(INTERNSHIP_NAME))) return 'the title is the internship product';
  if (name == null || !name.trim()) return 'the manifest has no name';
  const n = fold(name);
  if (n.includes(fold(INTERNSHIP_NAME))) return 'the manifest names the internship product';
  if (n === fold(FALLBACK_NAME)) return 'the manifest carries the coreCRM fallback name, so the brand is missing';
  if (!t.includes(n)) return 'the title does not contain the manifest name';
  return null;
}

// The origin a host number is keyed on. Deliberately a plain pattern rather
// than `new URL().origin`, because uptime.yml applies the same pattern in sed:
// the scheme and authority, lower-cased; a string without one keys on itself.
export function originKey(url) {
  const m = /^(https?:\/\/[^/?#]+)/.exec(url);
  return (m ? m[1] : url).toLowerCase();
}

// One host number per target: the 1-based place of its origin among the
// distinct origins of the list, in order of first appearance.
export function hostNumbers(targets) {
  const seen = new Map();
  return targets.map((url) => {
    const key = originKey(url);
    if (!seen.has(key)) seen.set(key, seen.size + 1);
    return seen.get(key);
  });
}

export function targetLabel(host, page) {
  return `marketing host #${host}, page #${page}`;
}

const REQUEST = {
  redirect: 'follow',
  headers: { 'user-agent': 'interncrm-uptime-content-probe/2 (+#2579)' },
};

function failureCode(err) {
  return err?.cause?.code || err?.name || 'error';
}

// The manifest of the host that finally answered, fetched once per URL however
// many of its pages are probed. Resolves to { name } or { problem }.
async function fetchManifest(manifestUrl, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(manifestUrl, {
      ...REQUEST,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...REQUEST.headers, accept: 'application/manifest+json, application/json' },
    });
  } catch (err) {
    return { problem: `manifest fetch failed (${failureCode(err)})` };
  }
  if (res.status !== 200) return { problem: `manifest HTTP ${res.status}` };
  try {
    return { name: manifestName(await res.text()) };
  } catch {
    return { problem: 'manifest body could not be read' };
  }
}

// Fetch one target and judge it. Never throws: a network error is a finding,
// not a crash, so one dead host cannot hide what the others say. `manifests`
// caches the manifest lookups of one run.
export async function probeTarget(url, fetchImpl = fetch, manifests = new Map()) {
  let res;
  try {
    res = await fetchImpl(url, {
      ...REQUEST,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...REQUEST.headers, accept: 'text/html' },
    });
  } catch (err) {
    return { url, problem: `fetch failed (${failureCode(err)})` };
  }
  if (res.status !== 200) return { url, problem: `HTTP ${res.status}` };
  let html;
  try {
    html = await res.text();
  } catch {
    return { url, problem: 'body could not be read' };
  }
  let manifestUrl;
  try {
    // After a redirect the page belongs to the host that answered, so that is
    // the host whose manifest counts.
    manifestUrl = new URL('/manifest.webmanifest', res.url || url).href;
  } catch {
    return { url, problem: 'not a valid URL' };
  }
  if (!manifests.has(manifestUrl)) manifests.set(manifestUrl, fetchManifest(manifestUrl, fetchImpl));
  const manifest = await manifests.get(manifestUrl);
  if (manifest.problem) return { url, problem: manifest.problem };
  return { url, problem: judge(extractTitle(html), manifest.name) };
}

export function parseTargets(argv, env) {
  const raw = argv.length ? argv.join(' ') : env.MARKETING_PROBE_URLS || '';
  return raw.split(/\s+/).filter(Boolean);
}

// The findings, one line each; `log` receives an OK/FAIL line per target.
export async function run(targets, fetchImpl = fetch, log = () => {}) {
  const hosts = hostNumbers(targets);
  const manifests = new Map();
  const results = await Promise.all(targets.map((u) => probeTarget(u, fetchImpl, manifests)));
  const lines = [];
  results.forEach((r, i) => {
    const label = targetLabel(hosts[i], i + 1);
    log(`${label}: ${r.problem ? 'FAIL' : 'OK'}`);
    if (r.problem) lines.push(`${label} -> ${r.problem}`);
  });
  return lines;
}

async function main() {
  const targets = parseTargets(process.argv.slice(2), process.env);
  if (!targets.length) {
    console.error('usage: marketing-content-probe.mjs <url>…  (or MARKETING_PROBE_URLS="<url> …")');
    process.exit(2);
  }
  const failures = await run(targets, fetch, (line) => console.error(line));
  for (const line of failures) console.log(line);
  process.exit(failures.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
