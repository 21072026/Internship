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
//   9. exactly one module under src/ reads APP_OPENAPI_SPEC, and it is the
//      ADMIN-only route handler
//  10. the VERIFY_EXEMPT allowlist still agrees with src/middleware.ts, in both
//      directions and with the same match semantics
//  11. every hardcoded DESTRUCTIVE key still names a real operation
//
// Checks 9-11 all exist for the same reason: each is a coupling between two
// files that would otherwise break SILENTLY - no type error, no failing test,
// just a document that has quietly started lying.
//
// What it does NOT catch: whether a derived request body matches what the
// handler actually accepts. Bodies are best-effort by design; an operation the
// analyser is unsure about is marked x-body-source: "unknown" rather than
// guessed at, and that is not a failure.
//
// Run: node scripts/check-openapi.mjs   (npm run check:openapi)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
//
// The set is deliberately just 'admin-session'. It used to also accept
// 'cron-secret' and 'shared-secret', which would let an /api/admin/* route
// guarded ONLY by a shared header pass this rule - and a shared secret is not an
// ADMIN session: it has no user, no role, no audit identity, and it is handed to
// monitors and schedulers. No route under /api/admin/ is classified that way
// today (the secret-guarded routes all live under /api/cron, /api/inbound-email
// and /api/webhooks), so narrowing costs nothing and closes the hole before
// someone adds one.
const ADMIN_OK = new Set(['admin-session']);
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

// 9 - the inlining hazard.
//
// next.config.js hands the generated document to the bundle through
// `nextConfig.env.APP_OPENAPI_SPEC`, and Next implements `env` with webpack's
// DefinePlugin: the value is substituted into the source of EVERY module that
// mentions the name. Today exactly one module does, and it is a server-only
// route handler behind an ADMIN check, so nothing reaches the browser. The
// moment a CLIENT component references it, the whole internal route inventory -
// ~300 KB naming every endpoint, its guard and its source file - is inlined into
// a publicly served /_next/static chunk, with no session check anywhere near it.
// Nothing else in the toolchain notices: it builds, it type-checks, the page
// works. Hence a grep with a single allowed file.
const SPEC_ENV_OWNER = path.join('src', 'app', 'api', 'admin', 'openapi', 'route.ts');
const SPEC_ENV_NAME = 'APP_OPENAPI_SPEC';
const sourceFilesUnder = (dir, acc = []) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // src/generated holds the inspection copy of the document itself.
      if (entry.name === 'generated' || entry.name === 'node_modules') continue;
      sourceFilesUnder(abs, acc);
    } else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
      acc.push(abs);
    }
  }
  return acc;
};
for (const abs of sourceFilesUnder(path.join(ROOT, 'src'))) {
  const rel = path.relative(ROOT, abs);
  if (!readFileSync(abs, 'utf8').includes(SPEC_ENV_NAME)) continue;
  if (rel === SPEC_ENV_OWNER) continue;
  problems.push(
    `${rel} references ${SPEC_ENV_NAME} - next.config.js exposes it through \`env\`, so DefinePlugin inlines the whole internal API inventory into every module that names it. Only ${SPEC_ENV_OWNER} (server-only, ADMIN-gated) may read it; anywhere else and a public /_next/static chunk ships the document.`,
  );
}

// 10 - VERIFY_EXEMPT is a hand-copy of the middleware allowlist.
//
// The generator uses it to decide whether an operation gets the "unverified
// users get 403 on this write" note and the 403 response. Edit one file and not
// the other and the document lies with nothing to catch it - which already
// happened once in the other direction, when the generator prefix-matched all
// seven entries while the middleware compares six of them for equality. So
// check both the membership AND the match operator, in both directions.
const middlewarePath = path.join(ROOT, 'src', 'middleware.ts');
if (!existsSync(middlewarePath)) {
  problems.push('src/middleware.ts is gone - VERIFY_EXEMPT in the generator is a copy of its allowlist and can no longer be verified');
} else {
  const middleware = readFileSync(middlewarePath, 'utf8');
  const allowlist = middleware.slice(middleware.indexOf('function isAllowlisted'));
  const body = allowlist.slice(0, allowlist.indexOf('\n}') + 1);
  for (const entry of generator.VERIFY_EXEMPT) {
    const quoted = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wanted = entry.endsWith('/')
      ? new RegExp(`pathname\\s*\\.\\s*startsWith\\s*\\(\\s*'${quoted}'`)
      : new RegExp(`pathname\\s*===\\s*'${quoted}'`);
    if (!wanted.test(body)) {
      problems.push(
        `VERIFY_EXEMPT lists "${entry}" but src/middleware.ts does not ${entry.endsWith('/') ? "startsWith-match" : 'compare pathname ==='} it - the generator would drop the unverified-user 403 from writes that really get one`,
      );
    }
  }
  const declared = new Set(generator.VERIFY_EXEMPT);
  const inMiddleware = [
    ...body.matchAll(/pathname\s*(?:===\s*'([^']+)'|\.\s*startsWith\s*\(\s*'([^']+)')/g),
  ].map((m) => m[1] || m[2]);
  for (const entry of inMiddleware) {
    if (entry.startsWith('/api/') && !declared.has(entry)) {
      problems.push(
        `src/middleware.ts exempts "${entry}" from the e-mail-verification gate but VERIFY_EXEMPT in scripts/openapi-generate.cjs does not - the document claims a 403 that endpoint never returns`,
      );
    }
  }
}

// 11 - the DESTRUCTIVE list is nine hardcoded "METHOD /api/path" strings, and
// the explorer's confirm gate is built from them. A route rename would leave the
// key pointing at nothing and quietly un-flag the endpoint.
const opKeys = new Set(operations.map(({ urlPath, method }) => `${method.toUpperCase()} ${urlPath}`));
for (const key of generator.DESTRUCTIVE) {
  if (!opKeys.has(key)) {
    problems.push(
      `DESTRUCTIVE lists "${key}" but no such operation exists - the path or verb was renamed and the explorer stopped confirming it. Fix the key in scripts/openapi-generate.cjs (or drop it if the endpoint is gone).`,
    );
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
