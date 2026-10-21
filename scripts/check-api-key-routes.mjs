#!/usr/bin/env node
// Guard: every /api/v1 route goes through the one door (#1546).
//
// An API-key request carries no session, so nothing in the framework resolves a
// tenant for it: `currentOrgId()` is undefined and the Prisma tenant middleware
// treats that as "no context, do not scope". A route that authenticates a key
// and then queries therefore reads EVERY organisation's rows while looking
// completely ordinary — that is exactly how GET /api/v1/candidates came to
// return every mentee in the database.
//
// `withApiKey()` (src/lib/apiKey.ts) is where expiry, revocation, scope, the
// organisation binding and the per-key rate limit are decided. There is a
// runtime half of this guard too (assertApiKeyRequestContext throws in
// development), but a route that is never exercised in development would still
// ship the hole, so the shape is checked statically as well:
//
//   1. no module outside src/lib/apiKey.ts calls authenticateApiKey()
//   2. every /api/v1 route that touches prisma goes through withApiKey()
//   3. the scope each one asks for is a real scope from lib/apiScopes.ts, and
//      (for /api/v1) one SCOPE_ENTITLEMENT gates on INTEGRATIONS_API (#1744)
//   4. every /api/v1 path is described in the public OpenAPI document
//   5. a key-authenticated route OUTSIDE /api/v1 (#2450: /api/v1 is frozen,
//      #2348 decision 3) is named in KEY_ROUTES_OUTSIDE_V1 with its reason, and
//      checks 2 and 3 apply to it exactly as to /api/v1
//
// Run: node scripts/check-api-key-routes.mjs   (npm run check:api-key-routes)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
// One walker over the route tree, shared with scripts/check-route-auth.mjs
// (#2444): two guards that disagree about which files exist would each think
// the other one covered the route neither of them saw.
import { routeFiles } from './lib/route-files.mjs';

const V1_DIR = 'src/app/api/v1';
const DOOR = 'src/lib/apiKey.ts';
const SPEC = 'src/app/api/v1/openapi.json/route.ts';
// The spec route is the public description of the API, not part of it: it is
// served anonymously on purpose so integrators can discover the surface.
const UNAUTHENTICATED = new Set([SPEC]);

const problems = [];

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

// The scope vocabulary, read from its single source rather than restated here.
const scopesSource = readFileSync('src/lib/apiScopes.ts', 'utf8');
const scopeList = scopesSource.match(/export const API_SCOPES\s*=\s*\[([^\]]*)\]/);
if (!scopeList) {
  console.error('check-api-key-routes FAILED — could not read API_SCOPES from src/lib/apiScopes.ts');
  process.exit(1);
}
const scopes = new Set([...scopeList[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

// Which scopes the plans sell as the public API (#1744). Read from the same
// file, so the door, key issuing and this guard share one table.
const entitlementTable = scopesSource.match(/export const SCOPE_ENTITLEMENT[^=]*=\s*\{([^}]*)\}/);
if (!entitlementTable) {
  console.error('check-api-key-routes FAILED — could not read SCOPE_ENTITLEMENT from src/lib/apiScopes.ts');
  process.exit(1);
}
const scopeEntitlement = new Map(
  [...entitlementTable[1].matchAll(/'([^']+)'\s*:\s*('INTEGRATIONS_API'|null)/g)].map((m) => [m[1], m[2] === 'null' ? null : 'INTEGRATIONS_API']),
);
for (const scope of scopes) {
  if (!scopeEntitlement.has(scope)) problems.push(`src/lib/apiScopes.ts  SCOPE_ENTITLEMENT has no entry for '${scope}'.`);
}

// 1. authenticateApiKey() is the door's own internal step, not a route's tool.
for (const file of sourceFiles('src')) {
  if (file.replace(/\\/g, '/') === DOOR) continue;
  const text = readFileSync(file, 'utf8');
  if (/\bauthenticateApiKey\s*\(/.test(text)) {
    problems.push(
      `${file}  calls authenticateApiKey() directly — an API-key request must be opened with ` +
        'withApiKey(), which also checks scope and binds the key\'s organisation.',
    );
  }
}

// Routes that may take ANY live key, with the reason (#2002). Nothing that
// reads or writes tenant data belongs here.
const ANY_SCOPE_ROUTES = {
  'src/app/api/v1/me/route.ts':
    'The connector auth test: the key\'s own org, scopes, expiry and limits — no user or candidate data.',
  // #3002: an export's scope is the scope of the resource named in the body
  // (or stored on the row), so the door cannot name it up front. Both handlers
  // call requireApiScope() with EXPORT_RESOURCES[resource].scope before they
  // write or read anything.
  'src/app/api/v1/exports/route.ts':
    'Queues an export of the resource in the body; that resource\'s read scope is required in the handler (requireApiScope).',
  'src/app/api/v1/exports/[id]/route.ts':
    'The status of an export this key made; the exported resource\'s read scope is required in the handler (requireApiScope).',
};

const files = routeFiles(V1_DIR);
const spec = readFileSync(SPEC, 'utf8');

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const authenticated = !UNAUTHENTICATED.has(file);

  // 2. reading data requires the door.
  if (authenticated && /\bprisma\./.test(text) && !/\bwithApiKey\s*\(/.test(text)) {
    problems.push(
      `${file}  queries the database without withApiKey() — the request would run with no ` +
        'organisation bound and read every tenant.',
    );
  }

  // 3a. a scope-less door (`withApiKey(request, ANY_LIVE_KEY, …)`) answers any
  // live key — only the connector handshake may be that open (#2002).
  if (/\bwithApiKey\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*(ANY_LIVE_KEY|null)\b/.test(text) && !ANY_SCOPE_ROUTES[file.replace(/\\/g, '/')]) {
    problems.push(
      `${file}  opens the door to ANY live key (ANY_LIVE_KEY) without an entry in ANY_SCOPE_ROUTES — ` +
        'a route that reads or writes data must ask for a scope.',
    );
  }

  // 3. the scope it asks for has to exist. `withApiKey(request, '<scope>', …)`.
  for (const m of text.matchAll(/withApiKey\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*'([^']*)'/g)) {
    if (!scopes.has(m[1])) {
      problems.push(
        `${file}  requires the scope '${m[1]}', which is not in API_SCOPES — no key can ever ` +
          'hold it, so the route answers 403 to everyone.',
      );
    } else if (scopeEntitlement.get(m[1]) !== 'INTEGRATIONS_API') {
      // 3b. /api/v1 is the public API the plans sell (#1744): its scope must be
      // one the door gates on INTEGRATIONS_API, or the route is free.
      problems.push(
        `${file}  asks for '${m[1]}', which SCOPE_ENTITLEMENT does not map to INTEGRATIONS_API — ` +
          'an /api/v1 route must be gated by the plan.',
      );
    }
  }

  // 4. an undocumented endpoint is an endpoint nobody knows is scoped.
  if (authenticated) {
    // A dynamic segment `[id]` is written `{id}` in OpenAPI (#1990).
    const path = '/' + file.slice(`${V1_DIR}/`.length).replace(/\/route\.[^/]+$/, '').replace(/\[([^\]]+)\]/g, '{$1}');
    if (!spec.includes(`'${path}'`)) {
      problems.push(
        `${file}  is not described in ${SPEC} — add '${path}' with the scope it requires.`,
      );
    }
  }
}

for (const listed of Object.keys(ANY_SCOPE_ROUTES)) {
  if (!files.some((f) => f.replace(/\\/g, '/') === listed)) {
    problems.push(`${listed}  is listed in ANY_SCOPE_ROUTES but does not exist — remove the entry.`);
  }
}

// 5. Key-authenticated routes outside /api/v1. Each one is a deliberate
// machine-to-machine door, so it is listed here with its reason — a new one
// cannot appear by accident.
const KEY_ROUTES_OUTSIDE_V1 = {
  'src/app/api/integrations/[source]/events/route.ts':
    'Account events (#2450, #2914): the machine-to-machine ingest a registered source system POSTs to ' +
    'with a companies:write key; the tenant is the key\'s bound org and the [source] slug is resolved ' +
    'inside it (IntegrationSource). Contract: docs/integrations/account-events.md.',
  'src/app/api/integrations/[source]/events/batch/route.ts':
    'Account-event batch (#2966): the same door as the single route (companies:write key, the [source] ' +
    'slug resolved inside the key\'s org, the key binding, the companies capability) for up to 200 events ' +
    'of a replay, with a dry run. Contract: docs/integrations/account-events.md § Batch.',
};
const outside = routeFiles('src/app/api').filter((f) => !f.replace(/\\/g, '/').startsWith(`${V1_DIR}/`));
for (const file of outside) {
  const text = readFileSync(file, 'utf8');
  if (!/\bwithApiKey\s*\(/.test(text)) continue;
  const key = file.replace(/\\/g, '/');
  if (!KEY_ROUTES_OUTSIDE_V1[key]) {
    problems.push(`${file}  opens an API-key door outside /api/v1 without an entry in KEY_ROUTES_OUTSIDE_V1.`);
  }
  for (const m of text.matchAll(/withApiKey\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*'([^']*)'/g)) {
    if (!scopes.has(m[1])) problems.push(`${file}  requires the scope '${m[1]}', which is not in API_SCOPES.`);
  }
}
for (const listed of Object.keys(KEY_ROUTES_OUTSIDE_V1)) {
  if (!outside.some((f) => f.replace(/\\/g, '/') === listed)) {
    problems.push(`${listed}  is listed in KEY_ROUTES_OUTSIDE_V1 but does not exist — remove the entry.`);
  }
}

if (problems.length > 0) {
  console.error('api-key routes FAILED — the public API must be entered through one door:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('\nSee withApiKey() in src/lib/apiKey.ts (#1546).');
  process.exit(1);
}

console.log(
  `api-key routes OK — ${files.length} /api/v1 route file(s), every authenticated one behind ` +
    `withApiKey(), scopes drawn from the ${scopes.size} known scope(s), all documented; ` +
    `${Object.keys(KEY_ROUTES_OUTSIDE_V1).length} listed key route(s) outside /api/v1.`,
);
