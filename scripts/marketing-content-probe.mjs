#!/usr/bin/env node
// Content probe for the marketing hosts (#2579).
//
// WHY THIS EXISTS
//   `/api/health` answers the same JSON on every host a container serves, so the
//   uptime check stays green when marketing.bcsit-gmbh.de is up but shows the
//   WRONG PRODUCT. That is not hypothetical: an empty `MARKETING_HOSTS` made the
//   prod marketing domain serve the internship landing until #2428
//   (2026-09-21), and nothing noticed until someone looked. The only check for
//   it was a `curl | grep '<title>'` in infra/README.md, run by hand.
//
//   The rule is the one that runbook line states: the page's `<title>` must name
//   the marketing product (`SaleVali`) and must NOT carry the internship title
//   (`Internship CRM`). Both halves matter — a title with neither means the page
//   is some third thing (an error page, a proxy placeholder), and that is wrong
//   too.
//
// CONTRACT (what .github/workflows/uptime.yml relies on)
//   - Every failing target prints ONE line on stdout: `<url> -> <reason>`. Those
//     lines are the alert's detail, verbatim.
//   - Green prints nothing on stdout and exits 0 — "green is silent".
//   - Any failure exits 1. A usage error (no targets) exits 2, so a broken
//     workflow edit cannot pass as "nothing to check".
//
// Plain ESM with no dependency on purpose: the uptime job runs this from a
// sparse checkout with no `npm ci`, on whatever Node the hosted runner ships.
//
// USAGE
//   node scripts/marketing-content-probe.mjs https://marketing.bcsit-gmbh.de/ …
//   CONTENT_TARGETS="https://a/ https://b/imprint" node scripts/marketing-content-probe.mjs
//   Tests: node --test scripts/test/marketing-content-probe.test.mjs

import { pathToFileURL } from 'node:url';

export const MUST_CONTAIN = 'SaleVali';
export const MUST_NOT_CONTAIN = 'Internship CRM';
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

// The document title, or null when the page has none. An inline `<svg>` may
// carry its own `<title>` (an icon's accessible name) — that is not the
// document's, so SVG blocks are dropped before looking.
export function extractTitle(html) {
  if (typeof html !== 'string') return null;
  const withoutSvg = html.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  const m = withoutSvg.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
}

// Pure verdict on one title: null when it is right, otherwise the reason.
export function titleProblem(title) {
  if (title == null) return 'no <title> in the page';
  if (title.includes(MUST_NOT_CONTAIN)) return `title "${title}" is the internship product`;
  if (!title.includes(MUST_CONTAIN)) return `title "${title}" does not name ${MUST_CONTAIN}`;
  return null;
}

// Fetch one target and judge it. Never throws: a network error is a finding,
// not a crash, so one dead host cannot hide what the others say.
export async function probeTarget(url, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'interncrm-uptime-content-probe/1 (+#2579)', accept: 'text/html' },
    });
  } catch (err) {
    return { url, problem: `fetch failed (${err?.cause?.code || err?.name || 'error'})` };
  }
  if (res.status !== 200) return { url, problem: `HTTP ${res.status}` };
  let html;
  try {
    html = await res.text();
  } catch {
    return { url, problem: 'body could not be read' };
  }
  return { url, problem: titleProblem(extractTitle(html)) };
}

export function parseTargets(argv, env) {
  const raw = argv.length ? argv.join(' ') : env.CONTENT_TARGETS || '';
  return raw.split(/\s+/).filter(Boolean);
}

export async function run(targets, fetchImpl = fetch) {
  const results = await Promise.all(targets.map((u) => probeTarget(u, fetchImpl)));
  return results.filter((r) => r.problem).map((r) => `${r.url} -> ${r.problem}`);
}

async function main() {
  const targets = parseTargets(process.argv.slice(2), process.env);
  if (!targets.length) {
    console.error('usage: marketing-content-probe.mjs <url>…  (or CONTENT_TARGETS="<url> …")');
    process.exit(2);
  }
  const failures = await run(targets);
  for (const line of failures) console.log(line);
  process.exit(failures.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
