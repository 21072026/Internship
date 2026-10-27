// The `check:skills` guard itself (#1816).
//
// `npm run check:skills` reading green on the real vocabulary only proves the
// data is clean today — not that the guard would notice the day it is not. A
// check that silently stopped checking would stay green forever. So this file
// runs the real script against fixture copies of the real seed, each broken in
// exactly one of the ways the issue names (a duplicated key, an alias another
// skill already claims, an adjacency to a key that does not exist), and
// requires a non-zero exit naming the offender. The untouched copy must pass,
// which proves a failure below is the injected defect and not fixture noise.
//
// Run: npm run test:skill-vocabulary  (node --test --experimental-strip-types)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKILL_CATEGORIES, SKILL_SEED } from '../../src/lib/skillSeed.ts';

const CHECKER = fileURLToPath(new URL('../check-skills.mjs', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'check-skills-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const clone = () => SKILL_SEED.map((e) => ({ ...e, aliases: [...e.aliases], adjacent: [...e.adjacent] }));
const entry = (seed, key) => {
  const found = seed.find((e) => e.key === key);
  assert.ok(found, `fixture needs the "${key}" entry`);
  return found;
};

function runOn(name, seed) {
  const file = path.join(dir, `${name}.mjs`);
  writeFileSync(
    file,
    `export const SKILL_CATEGORIES = ${JSON.stringify(SKILL_CATEGORIES)};\n` +
      `export const SKILL_SEED = ${JSON.stringify(seed)};\n`,
  );
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CHECKER, file], {
    encoding: 'utf8',
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

test('an untouched copy of the seed passes', () => {
  const { status, output } = runOn('clean', clone());
  assert.equal(status, 0, output);
});

test('a duplicated key fails', () => {
  const seed = clone();
  seed.push({ ...entry(seed, 'react'), labelEn: 'React (again)', labelTr: 'React (yine)', labelDe: 'React (erneut)', aliases: [], adjacent: [] });
  const { status, output } = runOn('duplicate-key', seed);
  assert.notEqual(status, 0, output);
  assert.match(output, /key "react": duplicated/);
});

test('an alias colliding with another skill fails', () => {
  const seed = clone();
  // "Postgres" belongs to postgresql; claiming it for mysql too must be caught.
  entry(seed, 'mysql').aliases.push('Postgres');
  const { status, output } = runOn('colliding-alias', seed);
  assert.notEqual(status, 0, output);
  assert.match(output, /"postgres" is claimed twice/);
});

test('an adjacency to a key that does not exist fails', () => {
  const seed = clone();
  entry(seed, 'react').adjacent.push('no-such-skill');
  const { status, output } = runOn('dangling-adjacency', seed);
  assert.notEqual(status, 0, output);
  assert.match(output, /adjacent "no-such-skill" is not a skill key/);
});

test('a missing translation fails', () => {
  const seed = clone();
  entry(seed, 'frontend').labelDe = '';
  const { status, output } = runOn('missing-label', seed);
  assert.notEqual(status, 0, output);
  assert.match(output, /key "frontend": labelDe is empty/);
});
