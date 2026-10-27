// Unit tests for the deploy's data-migration registry (#1540) —
// prisma/backfills/registry.mjs, run by prisma/run-backfills.mjs.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// What is pinned: every entry names a script that exists AND is in the image,
// the load-bearing ordering constraints hold, every optional entry says why,
// and infra/deploy-prod.sh runs backfills only through the runner — a new
// `run_tool node prisma/backfill-…` line there is how the registry would rot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { BACKFILLS } from '../../prisma/backfills/registry.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const indexOf = (slugEnd) => BACKFILLS.findIndex((b) => b.script.endsWith(slugEnd));

// The number is the ledger key's prefix, not the run order (the ARRAY is): an
// entry added later that must run before an existing one takes the next free
// number and its place in the list — renumbering would re-run a `once` entry.
test('ids are unique and numbered, no number reused', () => {
  const ids = BACKFILLS.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
  const numbers = ids.map((id) => {
    assert.match(id, /^\d{4}-[a-z0-9-]+$/, id);
    return Number(id.slice(0, 4));
  });
  assert.equal(new Set(numbers).size, numbers.length, 'a number is never reused');
});

test('every entry names a script that exists, with its flags as data', () => {
  for (const b of BACKFILLS) {
    assert.ok(existsSync(new URL(b.script, root)), `${b.id}: ${b.script} does not exist`);
    assert.equal(typeof b.once, 'boolean', `${b.id}: once`);
    assert.equal(typeof b.optional, 'boolean', `${b.id}: optional`);
    if (b.optional) assert.ok(b.why?.trim(), `${b.id}: an optional entry says why`);
    if (b.args) assert.ok(Array.isArray(b.args), `${b.id}: args is an array`);
  }
});

test('every registered script is in the runtime image, with the files it imports', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY --from=builder \/app\/prisma \.\/prisma/, 'prisma/ is copied whole');
  for (const b of BACKFILLS.filter((x) => !x.script.startsWith('prisma/'))) {
    assert.ok(dockerfile.includes(`/app/${b.script}`), `${b.script} is not COPY'd into the runner image`);
    for (const m of read(b.script).matchAll(/from '\.\/([^']+)'/g)) {
      const dep = b.script.replace(/[^/]+$/, m[1]);
      assert.ok(dockerfile.includes(`/app/${dep}`), `${dep} (imported by ${b.script}) is not COPY'd into the runner image`);
    }
  }
});

test('the ordering constraints hold', () => {
  const org = indexOf('backfill-organization.mjs');
  assert.ok(org > 0);
  for (const first of ['backfill-activity-log-org.mjs', 'backfill-audit-log-org.mjs', 'backfill-task-template-org.mjs', 'backfill-ai-usage-org.mjs', 'backfill-telemetry-org.mjs']) {
    assert.ok(indexOf(first) >= 0 && indexOf(first) < org, `${first} must run before backfill-organization`);
  }
  assert.ok(indexOf('backfill-api-key-lifecycle.mjs') > org, 'api-key-lifecycle needs the default org');
  assert.ok(indexOf('backfill-skill-lists.mjs') < indexOf('backfill-skill-taxonomy.mjs'), 'split before mapping');
  assert.ok(indexOf('backfill-skill-taxonomy.mjs') < indexOf('backfill-skill-levels.mjs'), 'rows before their levels');
});

test('deploy-prod.sh runs data migrations only through the runner', () => {
  const sh = read('infra/deploy-prod.sh');
  assert.equal((sh.match(/run_tool node prisma\/run-backfills\.mjs/g) ?? []).length, 1);
  // The post-push Json repair stays right after the push it repairs; the
  // pre-push steps are prisma/pre-push/registry.mjs (pre-push-registry.test.mjs).
  const bracketing = new Set(['backfill-json-columns.mjs']);
  for (const m of sh.matchAll(/^\s*run_tool node (?:prisma|scripts)\/((?:backfill|seed)-[^\s]+\.mjs)/gm)) {
    assert.ok(bracketing.has(m[1]), `${m[1]} is run directly by deploy-prod.sh — register it in prisma/backfills/registry.mjs instead`);
  }
  for (const b of BACKFILLS) assert.ok(!sh.includes(`node ${b.script}`), `${b.script} is both registered and run directly`);
});

test('the ledger is infrastructure, not tenant data', () => {
  const schema = read('prisma/schema.prisma');
  const model = schema.slice(schema.indexOf('model BackfillRun {'));
  assert.doesNotMatch(model.slice(0, model.indexOf('\n}')), /orgId/);
  assert.doesNotMatch(read('src/lib/orgContext.ts'), /'BackfillRun'/);
});
