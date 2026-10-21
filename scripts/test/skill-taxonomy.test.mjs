// Unit tests for the pure half of the canonical skill taxonomy (#1815).
//
// `src/lib/skillsResolve.ts` loads rows and hands them to these functions, so
// the properties that must hold on ANY data an admin can produce — a merge
// chain that loops, an adjacency graph with cycles — are pinned here, without
// a database. The DB-backed behaviour (React / react / React.js / REACTJS all
// landing on one row) is `e2e/skill-taxonomy.spec.ts`.
//
// Run: node --test --experimental-strip-types scripts/test/skill-taxonomy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillKey } from '../../src/lib/skills.ts';
import {
  MAX_SKILL_KEY_LENGTH,
  expandAdjacency,
  followMerges,
  isValidSkillLabel,
  skillKeyFromFolded,
  skillLabel,
} from '../../src/lib/skillTaxonomyRule.ts';

test('the fold keeps the characters that make C#, C++ and .NET distinct terms', () => {
  assert.equal(skillKey('C#'), 'c#');
  assert.equal(skillKey('.NET'), '.net');
  assert.notEqual(skillKey('C#'), skillKey('C'));
  assert.notEqual(skillKey('C++'), skillKey('C'));
  assert.equal(skillKeyFromFolded(skillKey('C#')), 'c#');
  assert.equal(skillKeyFromFolded(skillKey('.NET')), '.net');
});

test('a new skill key hyphenates whitespace and fits the column', () => {
  assert.equal(skillKeyFromFolded(skillKey('Data   Analysis')), 'data-analysis');
  assert.equal(skillKeyFromFolded(skillKey('Yazılım Testi')), 'yazilim-testi');
  assert.ok(skillKeyFromFolded('x'.repeat(200)).length <= MAX_SKILL_KEY_LENGTH);
});

test('a label needs a letter or a digit and must fit the column', () => {
  for (const ok of ['C#', '.NET', 'R', 'Go', '3D', 'Yazılım', 'Ölçme']) assert.ok(isValidSkillLabel(ok), ok);
  for (const bad of ['', '   ', '—', '...', '#', 'x'.repeat(61)]) assert.ok(!isValidSkillLabel(bad), JSON.stringify(bad));
});

test('skillLabel picks the locale and falls back to English', () => {
  const skill = { labelEn: 'Testing', labelTr: 'Test', labelDe: '' };
  assert.equal(skillLabel(skill, 'tr'), 'Test');
  assert.equal(skillLabel(skill, 'de'), 'Testing');
  assert.equal(skillLabel(skill, 'en'), 'Testing');
  assert.equal(skillLabel(skill, 'fr'), 'Testing');
});

test('followMerges walks to the end of a chain and stops on a cycle', () => {
  const chain = new Map([['a', 'b'], ['b', 'c'], ['c', null]]);
  assert.equal(followMerges('a', chain), 'c');
  assert.equal(followMerges('c', chain), 'c');
  assert.equal(followMerges('unknown', chain), 'unknown');
  const loop = new Map([['a', 'b'], ['b', 'a']]);
  assert.equal(followMerges('a', loop), 'b');
  const self = new Map([['a', 'a']]);
  assert.equal(followMerges('a', self), 'a');
});

const edge = (fromSkillId, toSkillId, weight = 0.5, kind = 'ADJACENT') => ({ fromSkillId, toSkillId, weight, kind });

test('expandAdjacency returns origins at 1 and neighbours below it', () => {
  const out = expandAdjacency(['react'], [edge('frontend', 'react', 0.6), edge('react', 'redux', 0.4)]);
  assert.deepEqual(out, [
    { skillId: 'react', weight: 1 },
    { skillId: 'frontend', weight: 0.6 },
    { skillId: 'redux', weight: 0.4 },
  ]);
});

test('expandAdjacency terminates on a cyclic edge set and never raises an origin', () => {
  const edges = [edge('a', 'b', 0.9), edge('b', 'c', 0.9), edge('c', 'a', 0.9), edge('a', 'a', 1)];
  const out = expandAdjacency(['a'], edges, 3);
  const byId = new Map(out.map((w) => [w.skillId, w.weight]));
  assert.equal(byId.get('a'), 1);
  assert.equal(byId.get('b'), 0.9);
  assert.equal(byId.get('c'), 0.9); // directly adjacent through c→a, read both ways
  assert.equal(out.length, 3);
});

test('expandAdjacency keeps the best path, honours depth and edge direction', () => {
  const edges = [edge('a', 'b', 0.5), edge('b', 'c', 0.5), edge('a', 'c', 0.2), edge('x', 'a', 0.9, 'BROADER')];
  const one = new Map(expandAdjacency(['a'], edges, 1).map((w) => [w.skillId, w.weight]));
  assert.equal(one.get('c'), 0.2);
  assert.equal(one.has('x'), false, 'BROADER is read from → to only');
  const two = new Map(expandAdjacency(['a'], edges, 2).map((w) => [w.skillId, w.weight]));
  assert.equal(two.get('c'), 0.25, 'the two-hop path beats the weak direct edge');
  assert.deepEqual(expandAdjacency(['a'], edges, 0), [{ skillId: 'a', weight: 1 }]);
  assert.deepEqual(expandAdjacency(['x'], edges, 1).map((w) => w.skillId), ['x', 'a']);
});

test('expandAdjacency ignores zero-weight edges and clamps odd weights', () => {
  const out = expandAdjacency(['a'], [edge('a', 'b', 0), edge('a', 'c', 7), edge('a', 'd', Number.NaN)]);
  const byId = new Map(out.map((w) => [w.skillId, w.weight]));
  assert.equal(byId.has('b'), false);
  assert.equal(byId.get('c'), 1);
  assert.equal(byId.get('d'), 0.5);
});

test('skillOverlap: direct at 1, adjacency at its weight, each target counted once', async () => {
  const { skillOverlap } = await import('../../src/lib/skillTaxonomyRule.ts');
  const edges = [edge('react', 'frontend', 0.6), edge('react', 'vue', 0.4), edge('vue', 'frontend', 0.7)];
  const exact = skillOverlap(['react'], ['react', 'frontend'], edges);
  assert.deepEqual(exact, { score: 1, direct: ['react'], adjacent: [] });
  const near = skillOverlap(['react'], ['frontend', 'vue'], edges);
  assert.equal(near.score, 0.6, 'best neighbour wins');
  assert.deepEqual(near.adjacent, [{ skillId: 'frontend', via: 'react', weight: 0.6 }]);
  assert.deepEqual(skillOverlap(['react'], ['frontend'], []).score, 0, 'no edge, no adjacency');
  assert.deepEqual(skillOverlap(['react'], ['vue'], edges, 0.5).adjacent, [], 'below the floor');
  assert.equal(skillOverlap(['react', 'react'], ['react'], edges).score, 1, 'targets de-duplicated');
});

test('requisitionSkillMatch: min(2, required) covered skills; letters in a title are irrelevant', async () => {
  const { requisitionSkillMatch } = await import('../../src/lib/skillTaxonomyRule.ts');
  assert.equal(requisitionSkillMatch(['typescript'], ['typescript'], []).isMatch, true);
  assert.equal(requisitionSkillMatch(['typescript', 'react', 'node'], ['typescript'], []).isMatch, false);
  assert.equal(requisitionSkillMatch(['typescript', 'react', 'node'], ['typescript', 'node'], []).isMatch, true);
  const edges = [edge('react', 'vue', 0.5)];
  assert.equal(requisitionSkillMatch(['typescript', 'react'], ['typescript', 'vue'], edges).isMatch, true);
  assert.equal(requisitionSkillMatch(['typescript', 'react'], ['typescript', 'vue'], [edge('react', 'vue', 0.3)]).isMatch, false);
  assert.equal(requisitionSkillMatch([], ['go'], []).isMatch, false, 'no required skills never matches on skills');
  assert.equal(requisitionSkillMatch(['golang-dev-title-is-not-a-skill'], ['go'], []).isMatch, false);
});
