#!/usr/bin/env node
// Guard: a query on a tenant model says which tenant it reads (#3588).
//
// WHY THIS EXISTS
//   The Prisma middleware in src/lib/orgContext.ts adds `orgId` to every query
//   on a TENANT_MODELS model — but only while MT_ENFORCE_ISOLATION is on, and it
//   is off in every deployment. A route that leaves the tenant to the middleware
//   therefore reads every org's rows in production. That is how #3578 (cohort
//   writes), #3587 (talent-pool search) and the sixteen #3588 findings happened,
//   each one invisible to the flag-on leak gate. The rule this check enforces:
//   the query carries its own tenant, whatever the flag says.
//
// WHAT COUNTS
//   In src/app/** (routes, pages, server code), every
//   `prisma|tx|db.<model>.<findMany|findFirst|findUnique|…|groupBy|upsert>(`
//   whose model is in TENANT_MODELS is a site. A site is SCOPED when:
//     * its argument text names the tenant: `orgId`, or a helper from
//       SCOPING_HELPERS below (each one was read and does write the org in);
//     * its argument text keys on the caller's own row (`session.user.id`,
//       `session.user.companyId`) — the caller's rows are their org's;
//     * it reads a single row and a one-row tenant guard from ROW_GUARDS
//       follows within GUARD_WINDOW lines (find by id, then check the org);
//     * its where is a variable (`{ where }`, `where: w`) and a scoping token
//       appears in the GUARD_WINDOW lines above it (the where was built there).
//   Anything else is UNSCOPED. That is a heuristic, deliberately on the strict
//   side: an unscoped site is not necessarily a leak (a write keyed on the id of
//   a row the handler already fetched with an org filter is fine), but it is a
//   site a reader has to reason about, and this check makes that reasoning
//   explicit instead of trusting a dormant middleware.
//
// THE RATCHET
//   scripts/tenant-queries-baseline.json lists, per file, the unscoped sites
//   that were reviewed and found safe, with the REASON they are safe — the
//   #3588 audit read every one of them. It is pinned in both directions:
//     * a file that is not listed and has an unscoped site fails — scope the
//       query (`withinTenant(…, await tenantWhere(session))`), or, if it is
//       safe for a reason the check cannot see, add an entry WITH that reason;
//     * a file whose count went UP fails — same;
//     * a file whose count went DOWN fails until the number is lowered, and a
//       file that reached zero (or no longer exists) fails until its entry is
//       deleted — so the list only shrinks.
//   `--shrink` lowers the counts and deletes the empty entries; it never adds
//   an entry or raises a number.
//
// Run: node scripts/check-tenant-queries.mjs            (npm run check:tenant-queries)
//      node scripts/check-tenant-queries.mjs --shrink
//      node scripts/check-tenant-queries.mjs --list      (every unscoped site)

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const SRC_DIR = 'src/app';
const BASELINE_FILE = 'scripts/tenant-queries-baseline.json';
const GUARD_WINDOW = 40;

const OPS = [
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'update', 'updateMany', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy', 'upsert',
];
const ONE_ROW_OPS = new Set(['findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow']);

/** Helpers that write the caller's org into the where they return. Each was read; add one only after reading it. */
export const SCOPING_HELPERS = [
  'withinTenant', 'tenantWhere', 'orgWhere', 'orgScoped', 'tenantAdminWhere', 'invitationOrgWhere',
  'visibleApplicationsWhere', 'interviewRequestActorWhere', 'readableGoalsWhere', 'visibleGoals',
  'outreachActorWhere', 'visibleEventsWhere', 'auditWhereFor', 'agendaTemplateWhere', 'scopeForRole',
  'meetingOrgWhere', 'visibleDraftsWhere', 'talentPoolVisibleWhere', 'mentorPoolWhere', 'settingsOrgOf',
  'resolveOrgId', 'orgInWorldWhere', 'orgWorldWhere',
];
/** One-row guards: find by id, then refuse another org's row. */
export const ROW_GUARDS = [
  'inCallerTenant', 'sameTenant', 'assertSameOrg', 'projectInCallerTenant', 'userInCallerOrg',
  'meetingInCallerTenant', 'isSuperAdminFor',
];
const OWN_ROW = /\bsession!?\??\.user!?\??\.(id|companyId)\b/;

const SCOPE_RE = new RegExp(String.raw`\borgId\b|\b(?:${SCOPING_HELPERS.join('|')})\b`);
const GUARD_RE = new RegExp(String.raw`\b(?:${ROW_GUARDS.join('|')})\b`);

/** TENANT_MODELS, read from the registry itself so the check never drifts from it. */
export function tenantModels(root = '.') {
  const src = readFileSync(path.join(root, 'src/lib/orgContext.ts'), 'utf8');
  const start = src.indexOf('const TENANT_MODELS');
  const block = src.slice(start, src.indexOf(']);', start));
  return [...block.matchAll(/^\s*'(\w+)',/gm)].map((m) => m[1]);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Comments out, line structure kept (so line numbers still match). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

function argsAt(src, i) {
  let depth = 1;
  let j = i;
  while (j < src.length && depth > 0) {
    const c = src[j];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    j++;
  }
  return src.slice(i, j - 1);
}

/** The unscoped sites of one source file's text. Pure — the unit test drives it. */
export function sitesInSource(text, file, modelNames) {
  const models = new Map(modelNames.map((m) => [m[0].toLowerCase() + m.slice(1), m]));
  const re = new RegExp(String.raw`\b(?:prisma|tx|db|trx|client)\.(\w+)\.(${OPS.join('|')})\(`, 'g');
  const src = stripComments(text);
  const lines = src.split('\n');
  const sites = [];
  let m;
  while ((m = re.exec(src))) {
    const model = models.get(m[1]);
    if (!model) continue;
    const args = argsAt(src, m.index + m[0].length);
    if (SCOPE_RE.test(args) || OWN_ROW.test(args)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    const after = lines.slice(line, line + GUARD_WINDOW).join('\n');
    if (ONE_ROW_OPS.has(m[2]) && GUARD_RE.test(after)) continue;
    const variableWhere = /\bwhere\b\s*[,}]|where:\s*[A-Za-z_$][\w$]*\s*[,}]|^\s*[A-Za-z_$][\w$]*\s*$/.test(args);
    const before = lines.slice(Math.max(0, line - GUARD_WINDOW), line).join('\n');
    if (variableWhere && (SCOPE_RE.test(before) || OWN_ROW.test(before))) continue;
    sites.push({ file, line, model, op: m[2] });
  }
  return sites;
}

/** Every unscoped tenant-model site under `dir`, as { file, line, model, op }. */
export function unscopedSites(root = '.', dir = SRC_DIR) {
  const modelNames = tenantModels(root);
  const sites = [];
  for (const file of walk(path.join(root, dir))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    sites.push(...sitesInSource(readFileSync(file, 'utf8'), rel, modelNames));
  }
  return sites;
}

function countByFile(sites) {
  const counts = {};
  for (const s of sites) counts[s.file] = (counts[s.file] ?? 0) + 1;
  return counts;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const sites = unscopedSites();
  if (args.has('--list')) {
    for (const s of sites) console.log(`${s.file}:${s.line}  ${s.model}.${s.op}`);
    return;
  }
  const counts = countByFile(sites);
  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : { reviewed: {} };
  const reviewed = baseline.reviewed ?? {};
  const errors = [];

  for (const [file, count] of Object.entries(counts)) {
    const entry = reviewed[file];
    if (!entry) {
      const where = sites.filter((s) => s.file === file).map((s) => `${s.line} (${s.model}.${s.op})`).join(', ');
      errors.push(`${file}: ${count} unscoped tenant-model quer${count === 1 ? 'y' : 'ies'} at line ${where}. Write the tenant into the query — withinTenant(…, await tenantWhere(session)) — or, if it is safe for a reason this check cannot see, add a reviewed entry with that reason to ${BASELINE_FILE}.`);
    } else if (!entry.reason || !String(entry.reason).trim()) {
      errors.push(`${file}: the baseline entry has no reason. Every reviewed entry says why its sites are safe.`);
    } else if (count > entry.count) {
      errors.push(`${file}: ${count} unscoped tenant-model queries, the baseline allows ${entry.count}. Scope the new one.`);
    }
  }
  const shrinkable = [];
  for (const [file, entry] of Object.entries(reviewed)) {
    const now = counts[file] ?? 0;
    if (now < entry.count) shrinkable.push([file, now]);
  }

  if (args.has('--shrink')) {
    for (const [file, now] of shrinkable) {
      if (now === 0) delete reviewed[file];
      else reviewed[file].count = now;
    }
    baseline.reviewed = Object.fromEntries(Object.entries(reviewed).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`Baseline shrunk: ${shrinkable.length} entr${shrinkable.length === 1 ? 'y' : 'ies'} lowered or removed.`);
  } else {
    for (const [file, now] of shrinkable) {
      errors.push(now === 0
        ? `${file}: no unscoped site left — delete its baseline entry (npm run check:tenant-queries -- --shrink).`
        : `${file}: down to ${now} unscoped site(s) from ${reviewed[file].count} — lower the baseline (npm run check:tenant-queries -- --shrink).`);
    }
  }

  if (errors.length) {
    console.error(`check:tenant-queries — ${errors.length} problem(s):\n`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error('\nWhy: the tenant middleware is off in every deployment, so a query that leaves the org to it reads every org (#3588, docs/tenant-isolation.md).');
    process.exit(1);
  }
  const total = Object.values(reviewed).reduce((n, e) => n + e.count, 0);
  console.log(`check:tenant-queries — ok: every tenant-model query in ${SRC_DIR} is scoped or reviewed (${total} reviewed site(s) in ${Object.keys(reviewed).length} file(s)).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
