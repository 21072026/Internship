#!/usr/bin/env node
// Guard: a Prisma model that carries `orgId` must be registered with the tenant
// middleware (#1560).
//
// WHY THIS EXISTS
//   `TENANT_MODELS` in src/lib/orgContext.ts is the list the Prisma `$use`
//   middleware consults before it injects the current request's orgId into a
//   query. A model that is NOT in that set is a silent pass-through: the
//   middleware simply never matches it, so nothing throws, nothing logs, and
//   the model is protected only by whatever `where` clause the last developer
//   remembered to write. A column named `orgId` makes the row *look* scoped
//   while it is not — the most expensive kind of wrong.
//
//   That is not hypothetical: the set drifted from the schema once and eight
//   models with a tenant key stayed unprotected for months before anyone
//   noticed. The rule ("a model that holds tenant data needs `orgId` AND an
//   entry in TENANT_MODELS") already existed in CLAUDE.md, and a rule that
//   lives only in a doc is a rule that gets skipped in a hurry.
//
//   Both directions are checked, because both are the same drift:
//     • a model with `orgId` that nothing registered  → unenforced tenant data;
//     • a name in the set that no longer matches a model with `orgId` → a
//       typo or a renamed model, which the middleware also ignores in silence.
//
// Run: node scripts/check-tenant-models.mjs   (npm run check:tenant-models)

import { readFileSync } from 'node:fs';

const SCHEMA_FILE = 'prisma/schema.prisma';
const ORG_CONTEXT_FILE = 'src/lib/orgContext.ts';

// ── Deliberate exclusions ────────────────────────────────────────────────────
// A model listed here carries (or will carry) `orgId` and is knowingly NOT
// auto-scoped. Every entry needs a written reason, so that an intentional
// omission is a code-review conversation and is distinguishable from a
// forgotten one. An entry naming a model that does not carry `orgId` *yet* is
// inert rather than an error — it is a standing decision about that model, and
// it starts applying the day the column lands.
const EXEMPT = new Map([
  [
    'Setting',
    // Key-value system settings. The tenant-aware rows are looked up per org, but
    // the legacy rows stay `orgId = NULL` on purpose: they are the global
    // fallback layer a tenant's own row overrides (#1557). Auto-scoping the
    // model would hide that fallback from every tenant at once.
    'legacy rows stay orgId = NULL as the global fallback layer (#1557)',
  ],
  [
    'Organization',
    // The tenant itself, keyed by `id`. It is the root of the scope, not a row
    // inside one — scoping it by an `orgId` column would be circular.
    'is the tenant, not a row inside one — scoped by its own id',
  ],
]);

// ── Pending registration (a ratchet, not an allowlist) ───────────────────────
// Models that carry `orgId`, are NOT yet registered, and are known to be
// unprotected today. Registering them changes runtime behaviour (the middleware
// starts injecting orgId into their creates too), so it is its own reviewed
// piece of work — #1559 — with its own cross-tenant spec.
//
// This list only ever shrinks: an entry that has since been registered, or
// whose model has lost its `orgId`, fails the check and must be deleted. Adding
// a NEW name here is not a way to pass CI — it is a deliberate declaration that
// the model is unprotected, and reviewers should treat it as such.
const PENDING_REGISTRATION = new Map(
  [
    'Tag',
    'StageSla',
    'PipelineStage',
    'CompanyInquiry',
    'Offer',
    'InterviewPanel',
    'EvaluationTemplate',
    'InvitationToken',
  ].map((model) => [model, 'awaiting registration + cross-tenant spec in #1559']),
);

// ── Parsing ──────────────────────────────────────────────────────────────────

// Every `model X { … }` block in the schema, mapped to whether it declares an
// `orgId` field (and how it is typed, which the report prints). Prisma model
// bodies contain no nested braces, so a non-greedy match to a line-start `}`
// is exact — and `prisma validate` runs in CI ahead of this, so the file is
// guaranteed to be well-formed by the time we get here.
function schemaModels(source) {
  const models = new Map();
  const blocks = source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm);
  for (const [, name, body] of blocks) {
    const field = body.match(/^\s*orgId\s+(\S+)/m);
    models.set(name, field ? { orgId: true, type: field[1] } : { orgId: false });
  }
  if (models.size === 0) throw new Error(`No models parsed out of ${SCHEMA_FILE}`);
  return models;
}

// The names inside `TENANT_MODELS = new Set([ … ])`, read as text rather than
// imported: orgContext.ts is server-only TypeScript that pulls in the Prisma
// client and node:async_hooks, none of which a plain-Node guard should need.
// Line comments are stripped first so a model name mentioned in the prose above
// an entry cannot be mistaken for one.
function registeredModels(source) {
  const block = source.match(/TENANT_MODELS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error(`Could not find TENANT_MODELS in ${ORG_CONTEXT_FILE}`);
  const body = block[1].replace(/\/\/[^\n]*/g, '');
  const names = [...body.matchAll(/['"`]([A-Za-z_]\w*)['"`]/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error('TENANT_MODELS parsed as empty');
  return names;
}

// ── Checks ───────────────────────────────────────────────────────────────────

const models = schemaModels(readFileSync(SCHEMA_FILE, 'utf8'));
const registered = registeredModels(readFileSync(ORG_CONTEXT_FILE, 'utf8'));
const registeredSet = new Set(registered);
const problems = [];

const tenantKeyed = [...models.entries()]
  .filter(([, info]) => info.orgId)
  .map(([name]) => name);

// 1. Every model with an `orgId` column is registered, exempt, or pending.
for (const model of tenantKeyed) {
  if (registeredSet.has(model)) continue;
  if (EXEMPT.has(model) || PENDING_REGISTRATION.has(model)) continue;
  problems.push(
    `${model} declares \`orgId ${models.get(model).type}\` in ${SCHEMA_FILE} but is not in ` +
      `TENANT_MODELS (${ORG_CONTEXT_FILE}). The middleware ignores unregistered models in ` +
      'silence, so its rows are scoped only by hand-written `where` clauses. Add ' +
      `'${model}' to TENANT_MODELS — or, if it must stay unscoped, add it to EXEMPT in this ` +
      'script with the reason.',
  );
}

// 2. Every registered name is a real model that still carries `orgId`. A typo
//    or a dropped column is the same silent no-op as forgetting the entry.
for (const model of registered) {
  if (!models.has(model)) {
    problems.push(
      `TENANT_MODELS lists '${model}', which is not a model in ${SCHEMA_FILE}. The middleware ` +
        'matches on the Prisma model name, so a name that does not exist never matches ' +
        'anything — check the spelling, or drop the entry if the model was removed.',
    );
    continue;
  }
  if (!models.get(model).orgId) {
    problems.push(
      `TENANT_MODELS lists '${model}', but that model no longer declares an \`orgId\` field. ` +
        'Either the column was dropped (remove the entry) or it was renamed (fix the schema).',
    );
  }
}

// 3. The two hand-maintained lists in this script have to stay honest too.
for (const [source, entries] of [
  ['EXEMPT', EXEMPT],
  ['PENDING_REGISTRATION', PENDING_REGISTRATION],
]) {
  for (const model of entries.keys()) {
    if (!models.has(model)) {
      problems.push(
        `${source} in this script names '${model}', which is not a model in ${SCHEMA_FILE}. ` +
          'Fix the spelling or drop the entry.',
      );
      continue;
    }
    if (registeredSet.has(model)) {
      problems.push(
        `'${model}' is in ${source} in this script AND in TENANT_MODELS. It is registered, so ` +
          `remove it from ${source} — a stale entry hides the next real omission.`,
      );
    }
  }
}

// A pending entry is a promise that the model still needs registering. Once the
// column is gone the promise is stale, and the ratchet has to notice.
for (const model of PENDING_REGISTRATION.keys()) {
  if (models.has(model) && !models.get(model).orgId && !registeredSet.has(model)) {
    problems.push(
      `PENDING_REGISTRATION names '${model}', which no longer declares an \`orgId\` field. ` +
        'Drop the entry.',
    );
  }
}

if (problems.length > 0) {
  console.error('tenant models FAILED — the middleware registry has drifted from the schema:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('\nSee docs/tenant-isolation.md § Keeping the registry honest.');
  process.exit(1);
}

// Pending entries are not a failure, but they are unprotected tenant data — say
// so on every run rather than letting the list settle into the background.
const pending = [...PENDING_REGISTRATION.keys()].filter((m) => models.get(m)?.orgId);
if (pending.length > 0) {
  console.warn(
    `tenant models: ${pending.length} model(s) carry orgId and are NOT auto-scoped yet — ` +
      `${pending.join(', ')} (${PENDING_REGISTRATION.get(pending[0])}).`,
  );
}

const exemptApplicable = [...EXEMPT.keys()].filter((m) => models.get(m)?.orgId);
console.log(
  `tenant models OK — ${tenantKeyed.length} model(s) declare orgId; ${registeredSet.size} ` +
    `registered in TENANT_MODELS, ${pending.length} pending (#1559), ${exemptApplicable.length} ` +
    `exempt by declared exception; every registered name resolves to a model that still has ` +
    'the column.',
);
