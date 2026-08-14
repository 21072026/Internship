import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Consistency check for the public demo's write blocklist (#966).
//
// WHY THIS EXISTS
//   DEMO_BLOCKED_WRITES in src/lib/demoMode.ts is a list of path patterns. The
//   realistic way it breaks is not a bad regex — it is a route being renamed or
//   moved months later, leaving a pattern that matches nothing. Nothing fails
//   when that happens: the demo just quietly starts accepting password changes
//   and file uploads again. This check makes that a red build instead.
//
//   The reverse direction is checked too: the upload and account-security routes
//   the demo is supposed to refuse must each be covered by some pattern, so a
//   NEW upload endpoint cannot be added without either covering it or
//   deliberately editing the expectation below.
//
// Usage: node scripts/check-demo-blocklist.mjs   (npm run check:demo-blocklist)

const API_DIR = 'src/app/api';
const DEMO_MODE_FILE = 'src/lib/demoMode.ts';

// Every API route, as the pathname the middleware actually sees. Dynamic
// segments become a concrete placeholder so the patterns can be tested against
// a real string.
function routePaths(dir, prefix = '/api') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const segment = entry.startsWith('[') ? 'SEGMENT' : entry;
      out.push(...routePaths(full, `${prefix}/${segment}`));
    } else if (entry === 'route.ts') {
      out.push(prefix);
    }
  }
  return out;
}

// Pull the pattern/reason pairs straight out of the source, so this cannot pass
// against a stale copy of the list.
function blockedPatterns() {
  const src = readFileSync(DEMO_MODE_FILE, 'utf8');
  const block = src.match(/DEMO_BLOCKED_WRITES[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error(`Could not find DEMO_BLOCKED_WRITES in ${DEMO_MODE_FILE}`);
  const found = [...block[1].matchAll(/\[\s*(\/(?:\\.|[^/\\])+\/)\s*,/g)].map((m) => m[1]);
  if (found.length === 0) throw new Error('DEMO_BLOCKED_WRITES parsed as empty');
  return found.map((literal) => {
    const body = literal.slice(1, -1);
    return { literal, re: new RegExp(body) };
  });
}

// Routes the demo must refuse. Each entry is [routePath, why] — kept here rather
// than derived, because "this endpoint stores a file" is a judgement about the
// route, not something a regex over the tree can tell.
const MUST_BE_BLOCKED = [
  ['/api/account', 'changes the shared account email/password'],
  ['/api/account/2fa', 'locks the shared account behind an authenticator'],
  ['/api/account/sign-out-all', 'signs other visitors out'],
  ['/api/admin/users/SEGMENT/erase', 'erases an account'],
  ['/api/admin/users/SEGMENT/reset-password', 'rotates a shared password'],
  ['/api/admin/webhooks', 'POSTs from the production host to any URL'],
  ['/api/admin/api-keys', 'mints a real credential'],
  ['/api/admin/email-test', 'mails an arbitrary recipient'],
  ['/api/cv', 'uploads a file'],
  ['/api/avatar', 'uploads a file'],
  ['/api/documents', 'uploads a file'],
];

const routes = routePaths(API_DIR);
const patterns = blockedPatterns();
const problems = [];

// 1. Every pattern must still match a route that exists.
for (const { literal, re } of patterns) {
  if (!routes.some((r) => re.test(r))) {
    problems.push(
      `pattern ${literal} matches no current API route — the route was probably renamed or removed, ` +
      `so the demo no longer refuses it. Update or drop the pattern.`
    );
  }
}

// 2. Every route that must be refused has to be matched by some pattern.
for (const [path, why] of MUST_BE_BLOCKED) {
  if (!routes.includes(path)) {
    problems.push(`expected route ${path} does not exist — update MUST_BE_BLOCKED in this script.`);
    continue;
  }
  if (!patterns.some(({ re }) => re.test(path))) {
    problems.push(`${path} is not blocked on the demo, but it ${why}. Add a pattern to DEMO_BLOCKED_WRITES.`);
  }
}

if (problems.length > 0) {
  console.error('demo blocklist check FAILED:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `demo blocklist OK — ${patterns.length} patterns, all matching live routes; ` +
  `${MUST_BE_BLOCKED.length} must-block routes all covered (${routes.length} API routes scanned)`
);
