#!/usr/bin/env node
// Guard: every API key scope and every /api/v1 prefix belongs to a product module (MKT-6b).
//
// A MARKETING org must neither be offered nor be served an internship-only part
// of the public API (requisitions, offers, interview requests). What decides that
// is two maps in src/lib/apiScopes.ts:
//
//   SCOPE_CAPABILITY      — the vertical capability each scope reads or writes
//   V1_PREFIX_CAPABILITY  — the capability of every top-level /api/v1 segment
//
// The door (withApiKey) and key issuing read the first one. A new scope or a
// new /api/v1 prefix that nobody mapped would sail through as "every vertical",
// silently. This fails the build instead, both ways:
//
//   1. every scope in API_SCOPES has a SCOPE_CAPABILITY entry, and no entry
//      names a scope that does not exist
//   2. every capability named is a real VerticalCapability (src/lib/verticals.ts)
//   3. every top-level entry under src/app/api/v1 has a V1_PREFIX_CAPABILITY
//      entry, and no entry names a prefix that does not exist
//   4. under a prefix with a capability, every withApiKey() scope maps to that
//      SAME capability, and none opens the door for ANY_LIVE_KEY: a route whose
//      scope is decided per request belongs under a `null` prefix
//
// Run: node scripts/check-api-scope-capabilities.mjs   (npm run check:api-scope-capabilities)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SCOPES_FILE = 'src/lib/apiScopes.ts';
const VERTICALS_FILE = 'src/lib/verticals.ts';
const V1_DIR = 'src/app/api/v1';

const problems = [];
const fail = (msg) => problems.push(msg);

const scopesSource = readFileSync(SCOPES_FILE, 'utf8');

function block(name) {
  const m = new RegExp(`export const ${name}\\b[^=]*=\\s*([\\[{])([\\s\\S]*?)\\n[\\]}]`).exec(scopesSource);
  if (!m) {
    console.error(`check-api-scope-capabilities FAILED — could not read ${name} from ${SCOPES_FILE}`);
    process.exit(1);
  }
  // Comments carry quoted words ("`candidates:read` is …"); only code counts.
  return m[2].replace(/\/\/.*$/gm, '');
}

const scopes = [...block('API_SCOPES').matchAll(/'([^']+)'/g)].map((m) => m[1]);
const entries = (src) =>
  [...src.matchAll(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*(?:'([^']+)'|(null))\s*,?\s*$/gm)].map((m) => ({
    key: m[1] ?? m[2],
    cap: m[3] ?? null,
  }));
const scopeCaps = entries(block('SCOPE_CAPABILITY'));
const prefixCaps = entries(block('V1_PREFIX_CAPABILITY'));

const verticalsSource = readFileSync(VERTICALS_FILE, 'utf8');
const union = /export type VerticalCapability\s*=([\s\S]*?);/.exec(verticalsSource);
if (!union) {
  console.error(`check-api-scope-capabilities FAILED — could not read VerticalCapability from ${VERTICALS_FILE}`);
  process.exit(1);
}
const capabilities = new Set([...union[1].replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1]));

// 1 + 2: scopes
const scopeCap = new Map(scopeCaps.map((e) => [e.key, e.cap]));
for (const s of scopes) if (!scopeCap.has(s)) fail(`scope '${s}' has no SCOPE_CAPABILITY entry — say which product module it belongs to`);
for (const e of scopeCaps) {
  if (!scopes.includes(e.key)) fail(`SCOPE_CAPABILITY names '${e.key}', which is not in API_SCOPES`);
  if (e.cap === null) fail(`SCOPE_CAPABILITY['${e.key}'] is null — every scope belongs to exactly one capability`);
  else if (!capabilities.has(e.cap)) fail(`SCOPE_CAPABILITY['${e.key}'] = '${e.cap}' is not a VerticalCapability`);
}

// 3: prefixes
const prefixes = readdirSync(V1_DIR);
const prefixCap = new Map(prefixCaps.map((e) => [e.key, e.cap]));
for (const p of prefixes) if (!prefixCap.has(p)) fail(`/api/v1/${p} has no V1_PREFIX_CAPABILITY entry — map it to a capability (or null with its reason)`);
for (const e of prefixCaps) {
  if (!prefixes.includes(e.key)) fail(`V1_PREFIX_CAPABILITY names '${e.key}', which is not a directory under ${V1_DIR}`);
  if (e.cap !== null && !capabilities.has(e.cap)) fail(`V1_PREFIX_CAPABILITY['${e.key}'] = '${e.cap}' is not a VerticalCapability`);
}

// 4: the scopes each prefix's routes ask for
function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}
let checkedRoutes = 0;
for (const p of prefixes) {
  const cap = prefixCap.get(p);
  if (!cap) continue;
  const path = join(V1_DIR, p);
  for (const file of statSync(path).isDirectory() ? files(path) : [path]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/withApiKey\(\s*\w+\s*,\s*('([^']+)'|[A-Za-z_$][\w$.]*)/g)) {
      checkedRoutes++;
      const scope = m[2];
      if (!scope) {
        fail(`${file}: withApiKey(…, ${m[1]}) under /api/v1/${p} ('${cap}') — a per-request scope belongs under a null prefix`);
        continue;
      }
      const sc = scopeCap.get(scope);
      if (sc && sc !== cap) fail(`${file}: scope '${scope}' is '${sc}', but /api/v1/${p} is '${cap}' — the two maps disagree`);
    }
  }
}

if (problems.length) {
  console.error(`check-api-scope-capabilities FAILED (MKT-6b, src/lib/apiScopes.ts):\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(
  `api scope capabilities OK — ${scopes.length} scopes and ${prefixes.length} /api/v1 prefixes mapped, ${checkedRoutes} withApiKey() call(s) agree with their prefix.`,
);
