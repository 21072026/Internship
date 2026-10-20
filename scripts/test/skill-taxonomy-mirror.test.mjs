// Pins the plain-ESM taxonomy copy the deploy backfill uses (#1819) to the
// TypeScript originals: `prisma/skill-seed.json` to SKILL_SEED,
// `prisma/skill-taxonomy-lib.mjs` to `buildSkillIndex` / `skillTaxonomyRule.ts`.
// A stale copy is a backfill that maps differently from the app.
//
// Run: npm run test:skill-taxonomy

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { skillKey } from '../../src/lib/skills.ts';
import { SKILL_SEED, buildSkillIndex } from '../../src/lib/skillSeed.ts';
import * as rule from '../../src/lib/skillTaxonomyRule.ts';
import { skillKey as mirrorFold } from '../../prisma/skill-split.mjs';
import * as lib from '../../prisma/skill-taxonomy-lib.mjs';

const json = JSON.parse(readFileSync(new URL('../../prisma/skill-seed.json', import.meta.url), 'utf8'));

test('prisma/skill-seed.json is the current SKILL_SEED (run npm run skills:seed-json)', () => {
  assert.deepEqual(json, JSON.parse(JSON.stringify(SKILL_SEED)));
});

test('the seed plan matches buildSkillIndex: same skills, tokens and undirected pairs', () => {
  const index = buildSkillIndex(skillKey, SKILL_SEED);
  const plan = lib.buildSeedPlan(json, mirrorFold);

  assert.deepEqual(plan.skills.map((s) => s.key), [...index.byKey.keys()]);
  const expectedAliases = [...index.tokens].filter(([t, k]) => t !== k && t.length <= 64);
  assert.deepEqual(plan.aliases.map((a) => [a.token, a.key]), expectedAliases);

  const expectedPairs = new Set();
  for (const [key, neighbours] of index.adjacency) for (const n of neighbours) if (key < n) expectedPairs.add(`${key}|${n}`);
  assert.deepEqual(new Set(plan.edges.map((e) => `${e.fromKey}|${e.toKey}`)), expectedPairs);
});

test('constants and pure helpers agree with skillTaxonomyRule.ts', () => {
  assert.equal(lib.MAX_SKILL_KEY_LENGTH, rule.MAX_SKILL_KEY_LENGTH);
  assert.equal(lib.DEFAULT_EDGE_WEIGHT, rule.DEFAULT_EDGE_WEIGHT);
  for (const s of ['Data   Analysis', 'C#', '.NET', 'Yazılım Testi', 'x'.repeat(100)]) {
    assert.equal(lib.skillKeyFromFolded(skillKey(s)), rule.skillKeyFromFolded(skillKey(s)), s);
  }
  const chains = [
    new Map([['a', 'b'], ['b', 'c'], ['c', null]]),
    new Map([['a', 'b'], ['b', 'a']]),
    new Map([['a', 'a']]),
  ];
  for (const chain of chains) assert.equal(lib.followMerges('a', chain), rule.followMerges('a', chain));
});

test('the in-memory resolver: key, derived key, alias, merge chain, retired → null', () => {
  const resolve = lib.makeResolver({
    skills: [
      { id: '1', key: 'react', status: 'ACTIVE', mergedIntoId: null },
      { id: '2', key: 'vue', status: 'RETIRED', mergedIntoId: '1' },
      { id: '3', key: 'data-analysis', status: 'ACTIVE', mergedIntoId: null },
      { id: '4', key: 'cobol', status: 'RETIRED', mergedIntoId: null },
    ],
    aliases: [{ key: 'reactjs', skillId: '1' }, { key: 'vue.js', skillId: '2' }],
  });
  assert.equal(resolve(mirrorFold('React')), '1');
  assert.equal(resolve(mirrorFold('REACTJS')), '1');
  assert.equal(resolve(mirrorFold('Vue.js')), '1', 'follows the merge');
  assert.equal(resolve(mirrorFold('Data Analysis')), '3', 'derived key');
  assert.equal(resolve(mirrorFold('COBOL')), null, 'retired');
  assert.equal(resolve(mirrorFold('Basket weaving')), null);
  assert.equal(resolve(''), null);
});

test('Turkish letters fold the same in the mirror as in the app', () => {
  for (const s of ['YAZILIM', 'yazılım', 'Yazilim', 'İŞ GÜVENLİĞİ', 'iş güvenliği', 'Görüntü İşleme']) {
    assert.equal(mirrorFold(s), skillKey(s), s);
  }
  assert.equal(mirrorFold('YAZILIM'), mirrorFold('yazilim'));
  assert.equal(mirrorFold('İş Güvenliği'), mirrorFold('is guvenligi'));
});
