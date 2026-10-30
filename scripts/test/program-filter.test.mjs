// Unit tests for the analytics programme filter (#1652).
//
// Run: node --test --experimental-strip-types scripts/test/program-filter.test.mjs
// (also covered by `npm run test:unit`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgramParam, relationProgramWhere, UNASSIGNED_PROGRAM } from '../../src/lib/programFilterRule.ts';

test('no parameter, an empty one and "all" are the unfiltered view', () => {
  for (const raw of [null, undefined, '', '  ', 'all']) assert.deepEqual(parseProgramParam(raw), { kind: 'all' });
  // 'all' must add NOTHING to a where, or the unfiltered numbers would change.
  assert.deepEqual(relationProgramWhere({ kind: 'all' }), {});
});

test('"unassigned" selects the relations with no programme', () => {
  assert.deepEqual(parseProgramParam(UNASSIGNED_PROGRAM), { kind: 'unassigned' });
  assert.deepEqual(relationProgramWhere({ kind: 'unassigned' }), { cohortId: null });
});

test('an id becomes a cohortId filter; a value that cannot be an id is refused', () => {
  assert.deepEqual(parseProgramParam('clx123abc'), { kind: 'program', id: 'clx123abc' });
  assert.deepEqual(relationProgramWhere({ kind: 'program', id: 'clx123abc' }), { cohortId: 'clx123abc' });
  for (const bad of ['a b', "x' OR 1=1", 'x'.repeat(65), '../etc']) assert.equal(parseProgramParam(bad), null);
});
