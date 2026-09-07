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
//   3. the scope each one asks for is a real scope from lib/apiScopes.ts
//   4. every /api/v1 path is described in the public OpenAPI document
//
// Run: node scripts/check-api-key-routes.mjs   (npm run check:api-key-routes)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const V1_DIR = 'src/app/api/v1';
const DOOR = 'src/lib/apiKey.ts';
const SPEC = 'src/app/api/v1/openapi.json/route.ts';
// The spec route is the public description of the API, not part of it: it is
// served anonymously on purpose so integrators can discover the surface.
const UNAUTHENTICATED = new Set([SPEC]);

const problems = [];

function routeFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...routeFiles(path));
    else if (entry === 'route.ts') out.push(path);
  }
  return out;
}

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

const files = routeFiles(V1_DIR).map((f) => f.replace(/\\/g, '/'));
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

  // 3. the scope it asks for has to exist. `withApiKey(request, '<scope>', …)`.
  for (const m of text.matchAll(/withApiKey\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*'([^']*)'/g)) {
    if (!scopes.has(m[1])) {
      problems.push(
        `${file}  requires the scope '${m[1]}', which is not in API_SCOPES — no key can ever ` +
          'hold it, so the route answers 403 to everyone.',
      );
    }
  }

  // 4. an undocumented endpoint is an endpoint nobody knows is scoped.
  if (authenticated) {
    const path = '/' + file.slice(`${V1_DIR}/`.length, -'/route.ts'.length);
    if (!spec.includes(`'${path}'`)) {
      problems.push(
        `${file}  is not described in ${SPEC} — add '${path}' with the scope it requires.`,
      );
    }
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
    `withApiKey(), scopes drawn from the ${scopes.size} known scope(s), all documented.`,
);
