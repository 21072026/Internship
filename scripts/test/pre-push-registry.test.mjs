// Unit tests for the steps before `prisma db push` (#3144) —
// prisma/pre-push/registry.mjs, run by prisma/run-pre-push.mjs.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// What is pinned: every step names a script that exists and is in the image,
// the expand-before-backfill order holds, and ALL THREE paths that push onto
// existing tables (prod/preview, topic, demo) run the steps only through the
// runner. A hand-copied line in one of them is how the demo lost
// push-setting-program-expand.mjs and died on its next push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRE_PUSH_STEPS } from '../../prisma/pre-push/registry.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const indexOf = (id) => PRE_PUSH_STEPS.findIndex((s) => s.id === id);

const CALLERS = {
  'infra/deploy-prod.sh': /^run_tool node prisma\/run-pre-push\.mjs$/m,
  'infra/server/topic-deploy.sh': /^\s*_in_image "\$IMAGE" node prisma\/run-pre-push\.mjs --keep-going \|\| true$/m,
  'infra/server/demo-refresh.sh': /^run node prisma\/run-pre-push\.mjs$/m,
};

test('every step names a script that exists, with its flags as data', () => {
  const ids = PRE_PUSH_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const s of PRE_PUSH_STEPS) {
    assert.match(s.id, /^[a-z0-9-]+$/, s.id);
    assert.ok(s.script.startsWith('prisma/'), `${s.id}: lives under prisma/, which the image copies whole`);
    assert.ok(existsSync(new URL(s.script, root)), `${s.id}: ${s.script} does not exist`);
    assert.equal(typeof s.optional, 'boolean', `${s.id}: optional`);
    assert.ok(s.why?.trim(), `${s.id}: says why it exists`);
    if (s.args) assert.ok(Array.isArray(s.args), `${s.id}: args is an array`);
  }
  assert.match(read('Dockerfile'), /COPY --from=builder \/app\/prisma \.\/prisma/, 'prisma/ is copied whole');
});

test('the order holds: each expand before its backfill, the Json repair last', () => {
  assert.ok(indexOf('company-interest-expand') < indexOf('company-interest-scope'));
  assert.ok(indexOf('setting-id-expand') < indexOf('setting-id'));
  assert.ok(indexOf('setting-program-expand') >= 0);
  assert.equal(PRE_PUSH_STEPS.at(-1).id, 'json-columns-repair');
  for (const s of PRE_PUSH_STEPS.filter((x) => x.script.includes('-expand.mjs'))) {
    assert.equal(s.optional, false, `${s.id}: an expand the push depends on is required`);
  }
});

test('every expand helper in the tree is registered', () => {
  const registered = new Set(PRE_PUSH_STEPS.map((s) => s.script));
  const helpers = spawnSync('git', ['ls-files', 'prisma/push-*-expand.mjs'], { cwd: fileURLToPath(root), encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean);
  assert.ok(helpers.length > 0, 'git ls-files found the helpers');
  for (const h of helpers) assert.ok(registered.has(h), `${h} exists but is not in prisma/pre-push/registry.mjs`);
});

test('all three push paths run the steps through the runner, never directly', () => {
  for (const [file, runnerLine] of Object.entries(CALLERS)) {
    const sh = read(file);
    assert.equal((sh.match(/node prisma\/run-pre-push\.mjs/g) ?? []).length, 1, `${file}: runs the runner exactly once`);
    assert.match(sh, runnerLine, `${file}: the runner line`);
    assert.doesNotMatch(sh, /node prisma\/push-[^\s]+-expand\.mjs/, `${file}: an expand push run directly — register it instead`);
    for (const s of PRE_PUSH_STEPS) {
      const direct = sh.split('\n').filter((l) => !l.trim().startsWith('#') && l.includes(`node ${s.script}`));
      if (file === 'infra/deploy-prod.sh' && s.id === 'json-columns-repair') {
        // The post-push repair is a different step with the same script (#1150):
        // exactly one, after the push.
        assert.equal(direct.length, 1, `${file}: one post-push Json repair`);
        assert.ok(sh.indexOf(direct[0]) > sh.indexOf('npx prisma db push --accept-data-loss'), `${file}: the remaining repair is post-push`);
        continue;
      }
      assert.equal(direct.length, 0, `${file}: runs ${s.script} directly — it is in prisma/pre-push/registry.mjs`);
    }
  }
});

test('each path runs the steps before its push', () => {
  for (const file of Object.keys(CALLERS)) {
    const sh = read(file);
    const runner = sh.indexOf('node prisma/run-pre-push.mjs');
    const push = sh.indexOf('npx prisma db push --accept-data-loss', runner);
    assert.ok(runner > 0 && push > runner, `${file}: runner before the push`);
  }
});

test('the demo checks for the runner before it wipes, and wipes before the steps', () => {
  const sh = read('infra/server/demo-refresh.sh');
  const check = sh.indexOf('test -f prisma/run-pre-push.mjs');
  const wipe = sh.indexOf('run node prisma/reset-demo.mjs');
  const runner = sh.indexOf('run node prisma/run-pre-push.mjs');
  assert.ok(check > 0 && check < wipe, 'an image without the runner stops before anything is wiped');
  assert.ok(wipe < runner, 'empty tables accept every contract step');
});

test('the runner lists the plan in registry order without touching a database', () => {
  const out = spawnSync(process.execPath, ['prisma/run-pre-push.mjs', '--list'], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'mysql://u:p@192.0.2.1:3306/never_used' },
  });
  assert.equal(out.status, 0, out.stderr);
  const listed = [...out.stdout.matchAll(/^\[pre-push\] ([a-z0-9-]+): would run node (\S+)/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(listed, PRE_PUSH_STEPS.map((s) => [s.id, s.script]));
});
