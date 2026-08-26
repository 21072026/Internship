#!/usr/bin/env node
// Guard: the generated API description must not quietly lie.
//
// Why this exists. /admin/api-explorer publishes what scripts/openapi-generate.cjs
// derives from src/app/api. A static analyser degrades silently: a route written
// in a shape it does not recognise does not throw, it just disappears from the
// document - and an endpoint that is missing from the explorer, or worse, shown
// with the wrong access badge, is a security-relevant wrong answer wearing the
// authority of generated documentation. The failure mode that motivated this
// check is concrete: four endpoints in this repo (admin/document-requirements,
// inbound-email, webhooks/jaas, health) keep their guard in a module-scope
// helper, and the first draft of the analyser labelled all four "no credential
// required".
//
// So this re-derives the document and asserts the properties that must hold:
//   1. every route.ts contributes at least one operation
//   2. the generator reported no warnings (unhandled shape, param mismatch)
//   3. operationIds are unique - Swagger UI misbehaves silently on duplicates
//   4. every operation carries a summary and an x-auth classification
//   5. nothing under /api/admin/ is described as callable without an ADMIN
//      session, and nothing anywhere is described as "public" unless the
//      analyser really found no credential
//   6. no summary or description leaks what the sanitiser is supposed to strip
//      (env-var names ending in SECRET/TOKEN/KEY/PASSWORD, URLs, internal hosts)
//   7. the output is deterministic - two runs are byte-identical, so a rebuild
//      never produces a spurious diff
//   8. the PUBLIC spec route still exists. It is a separate, hand-written
//      document with its own security-scheme name, and this generator must
//      never replace or shadow it.
//
// What it does NOT catch: whether a derived request body matches what the
// handler actually accepts. Bodies are best-effort by design; an operation the
// analyser is unsure about is marked x-body-source: "unknown" rather than
// guessed at, and that is not a failure.
//
// Run: node scripts/check-openapi.mjs   (npm run check:openapi)

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const generator = require('./openapi-generate.cjs');
// npm scripts run from the repo root; overridable so the guard can be pointed
// at a fixture tree.
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

const problems = [];
const built = generator.buildSpec(ROOT);

if (!built) {
  console.error(`openapi check FAILED:\n\n  - ${generator.API_DIR} does not exist under ${ROOT}, so there is nothing to describe.\n`);
  process.exit(1);
}

const { spec, stats } = built;

// 1 + 2 - the generator already reports both as warnings.
for (const warning of stats.warnings) problems.push(warning);

const operations = [];
for (const [urlPath, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (method === 'parameters') continue;
    operations.push({ urlPath, method, op });
  }
}

// 3
const seen = new Map();
for (const { urlPath, method, op } of operations) {
  if (seen.has(op.operationId)) problems.push(`duplicate operationId "${op.operationId}": ${method.toUpperCase()} ${urlPath} and ${seen.get(op.operationId)}`);
  else seen.set(op.operationId, `${method.toUpperCase()} ${urlPath}`);
}

// 4
for (const { urlPath, method, op } of operations) {
  const where = `${method.toUpperCase()} ${urlPath}`;
  if (!op.summary || !op.summary.trim()) problems.push(`${where}: empty summary`);
  if (!op['x-auth']) problems.push(`${where}: no x-auth classification`);
  if (!op.responses || !Object.keys(op.responses).length) problems.push(`${where}: no responses`);
}

// 5 - the classification that must never be wrong.
// role-session counts only when ADMIN is one of the roles: POST
// /api/admin/duplicates/check is deliberately ADMIN-or-MENTOR (mentors get
// duplicate detection while inviting). "any-session" or "public" under
// /api/admin/ never counts.
const ADMIN_OK = new Set(['admin-session', 'cron-secret', 'shared-secret']);
for (const { urlPath, method, op } of operations) {
  if (!urlPath.startsWith('/api/admin/')) continue;
  const shared = op['x-auth'] === 'role-session' && (op['x-roles'] || []).includes('ADMIN');
  if (!ADMIN_OK.has(op['x-auth']) && !shared) {
    problems.push(`${method.toUpperCase()} ${urlPath}: classified "${op['x-auth']}" - an /api/admin/ endpoint that does not resolve to an ADMIN guard is either a real authorization hole or a guard shape the analyser cannot follow. Both need a human.`);
  }
}

// 6 - the sanitiser, verified on its own output rather than trusted.
const LEAKS = [
  [/\b[A-Z][A-Z0-9_]{3,}(SECRET|TOKEN|KEY|PASSWORD)\b/, 'names an env var holding a credential'],
  [/https?:\/\//, 'contains a URL'],
  [/localhost|127\.0\.0\.1|\.ersah\.in/, 'names an internal host'],
  [/process\.env\./, 'quotes a process.env lookup'],
];
for (const { urlPath, method, op } of operations) {
  for (const field of ['summary', 'description']) {
    const value = op[field] || '';
    for (const [re, why] of LEAKS) {
      if (re.test(value)) problems.push(`${method.toUpperCase()} ${urlPath}: ${field} ${why} - the comment sanitiser let it through`);
    }
  }
}

// 7
const again = generator.buildSpec(ROOT);
if (JSON.stringify(again.spec) !== JSON.stringify(spec)) {
  problems.push('two runs produced different output - the generator is not deterministic, so every build would show a spurious diff');
}

// 8 - the public document is a separate, hand-written file. Leave it alone.
const publicSpec = path.join(ROOT, 'src', 'app', 'api', 'v1', 'openapi.json', 'route.ts');
if (!existsSync(publicSpec)) {
  problems.push('src/app/api/v1/openapi.json/route.ts is gone - the public API description must keep being served, unauthenticated and unchanged');
} else {
  const source = readFileSync(publicSpec, 'utf8');
  for (const marker of ['securitySchemes', 'x-webhooks']) {
    if (!source.includes(marker)) problems.push(`the public spec route no longer declares ${marker} - it is the document integrators read; do not fold it into the internal one`);
  }
}

if (problems.length) {
  console.error('openapi check FAILED:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nSee the header of scripts/openapi-generate.cjs for how each fact is derived, and docs/api-explorer.md for the design.\n');
  process.exit(1);
}

const authSummary = Object.entries(stats.byAuth)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}=${v}`)
  .join(' ');
console.log(
  `openapi OK - ${operations.length} operations over ${Object.keys(spec.paths).length} paths from ${stats.files} route files; ` +
    `all operationIds unique, no /api/admin endpoint unguarded, no redacted text leaked, output deterministic (${authSummary})`,
);
