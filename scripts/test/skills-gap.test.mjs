// Unit tests for the skills-gap report rule (#1823).
//
// Pins the definitions the panel's footnotes promise: only HIRING requisitions
// are demand, demand is weighted by the seats still open, the gap is seats
// minus people, and coverage needs ONE person holding the whole required set.
//
// Run: node --test --experimental-strip-types scripts/test/skills-gap.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSkillsGap, isHiring } from '../../src/lib/skillsGapRule.ts';

const h = (userId, skillId, level = null, verified = false) => ({ userId, skillId, level, verified });
const req = (id, skillIds, { status = 'OPEN', openings = 1, filled = 0 } = {}) => ({ id, status, openings, filled, skillIds });

test('only OPEN requisitions with a free seat are hiring', () => {
  assert.equal(isHiring({ status: 'OPEN', openings: 2, filled: 1 }), true);
  assert.equal(isHiring({ status: 'OPEN', openings: 2, filled: 2 }), false);
  for (const status of ['DRAFT', 'ON_HOLD', 'FILLED', 'CANCELLED']) {
    assert.equal(isHiring({ status, openings: 3, filled: 0 }), false, status);
  }
});

test('demand is weighted by remaining seats; non-hiring requisitions add nothing', () => {
  const report = buildSkillsGap([], [
    req('a', ['ts'], { openings: 3, filled: 1 }),
    req('b', ['ts']),
    req('c', ['ts'], { status: 'DRAFT', openings: 9 }),
    req('d', ['ts'], { openings: 2, filled: 2 }),
  ]);
  const ts = report.rows.find((r) => r.skillId === 'ts');
  assert.deepEqual([ts.demandRequisitions, ts.demandOpenings], [2, 3]);
  assert.equal(report.hiringRequisitions, 2);
});

test('gap = seats − people; ranked both ways', () => {
  const report = buildSkillsGap(
    [h('u1', 'react', 4), h('u2', 'react', 2, true), h('u1', 'go'), h('u3', 'excel')],
    [req('a', ['react', 'k8s'], { openings: 4 }), req('b', ['go'])],
  );
  const by = Object.fromEntries(report.rows.map((r) => [r.skillId, r]));
  assert.equal(by.k8s.gap, 4);
  assert.equal(by.react.gap, 2);
  assert.equal(by.go.gap, 0);
  assert.equal(by.excel.gap, -1);
  assert.deepEqual(report.underSupplied.map((r) => r.skillId), ['k8s', 'react']);
  assert.deepEqual(report.unused.map((r) => r.skillId), ['excel']);
  assert.equal(by.react.avgLevel, 3);
  assert.equal(by.react.confirmed, 1);
  assert.equal(by.go.avgLevel, null);
});

test('a person holding a skill twice counts once', () => {
  const report = buildSkillsGap([h('u1', 'sql', 2), h('u1', 'sql', 5)], []);
  assert.equal(report.rows[0].holders, 1);
  assert.equal(report.rows[0].avgLevel, 2);
});

test('coverage needs one person with the whole required set', () => {
  const split = buildSkillsGap([h('u1', 'react'), h('u2', 'node')], [req('a', ['react', 'node'])]);
  assert.deepEqual(split.coverage, { covered: 0, total: 1, share: 0 });
  const whole = buildSkillsGap([h('u1', 'react'), h('u1', 'node')], [req('a', ['react', 'node']), req('b', ['go'])]);
  assert.deepEqual(whole.coverage, { covered: 1, total: 2, share: 0.5 });
});

test('a hiring requisition without canonical skills is reported, never counted as covered', () => {
  const report = buildSkillsGap([h('u1', 'react')], [req('a', [])]);
  assert.deepEqual(report.coverage, { covered: 0, total: 0, share: null });
  assert.equal(report.requisitionsWithoutSkills, 1);
});
