// Unit tests for the per-cohort / per-mentor service-level rule (#1640).
//
// Run: npm run test:stage-sla-rule  (node --test --experimental-strip-types)
//
// Every case runs through BOTH copies of the rule — src/lib/stageSlaRule.ts
// (the request path) and prisma/stage-sla-rule.mjs (the deploy backfill, which
// Node 20 runs without a TypeScript step) — so the two cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ts from '../../src/lib/stageSlaRule.ts';
import * as esm from '../../prisma/stage-sla-rule.mjs';

const ORG = { stageKey: 'S', days: 7 };
const COHORT = { stageKey: 'S', days: 5, cohortId: 'c1' };
const MENTOR = { stageKey: 'S', days: 10, mentorId: 'm1' };
const BOTH = { stageKey: 'S', days: 3, mentorId: 'm1', cohortId: 'c1' };

for (const [name, rule] of [['ts', ts], ['esm', esm]]) {
  const days = (rows, scope) => rule.resolveSlaDays(rows, scope).get('S') ?? null;

  test(`${name}: with only org rows resolution is identical to before`, () => {
    assert.deepEqual(days([ORG], {}), { days: 7, source: 'org' });
    assert.deepEqual(days([ORG], { cohortId: 'c1', mentorId: 'm1' }), { days: 7, source: 'org' });
    assert.equal(days([], { cohortId: 'c1' }), null);
  });

  test(`${name}: mentor+cohort → mentor → cohort → org`, () => {
    const all = [ORG, COHORT, MENTOR, BOTH];
    assert.equal(days(all, { cohortId: 'c1', mentorId: 'm1' }).source, 'mentorCohort');
    assert.equal(days([ORG, COHORT, MENTOR], { cohortId: 'c1', mentorId: 'm1' }).source, 'mentor');
    assert.equal(days([ORG, COHORT], { cohortId: 'c1', mentorId: 'm1' }).days, 5);
    assert.equal(days(all, { cohortId: 'c2', mentorId: 'm2' }).source, 'org');
    // Row order never decides.
    assert.deepEqual(days([BOTH, MENTOR, COHORT, ORG], { cohortId: 'c1', mentorId: 'm1' }), { days: 3, source: 'mentorCohort' });
  });

  test(`${name}: an override for another cohort or mentor does not apply`, () => {
    assert.equal(days([COHORT, MENTOR, BOTH], { cohortId: 'c9', mentorId: 'm9' }), null);
    // mentor+cohort needs BOTH to match
    assert.equal(days([BOTH], { cohortId: 'c1', mentorId: 'm2' }), null);
    assert.equal(days([BOTH], { mentorId: 'm1' }), null);
  });

  test(`${name}: a scope without a number does not mask a less specific one`, () => {
    assert.deepEqual(days([ORG, { stageKey: 'S', days: null, cohortId: 'c1' }], { cohortId: 'c1' }), { days: 7, source: 'org' });
  });

  test(`${name}: scope keys are unique per pair and "org" for none`, () => {
    assert.equal(rule.slaScopeKey({}), 'org');
    assert.equal(rule.slaScopeKey({ cohortId: '', mentorId: null }), 'org');
    assert.equal(rule.slaScopeKey({ cohortId: 'c1' }), 'c:c1');
    assert.equal(rule.slaScopeKey({ mentorId: 'm1' }), 'm:m1');
    assert.equal(rule.slaScopeKey({ cohortId: 'c1', mentorId: 'm1' }), 'm:m1|c:c1');
  });
}

test('the TS rule and its plain-ESM twin agree on a corpus', () => {
  const rows = [ORG, COHORT, MENTOR, BOTH, { stageKey: 'T', days: 2, cohortId: 'c2' }, { stageKey: 'T', days: null }];
  const scopes = [{}, { cohortId: 'c1' }, { mentorId: 'm1' }, { cohortId: 'c1', mentorId: 'm1' }, { cohortId: 'c2', mentorId: 'm1' }];
  for (const scope of scopes) {
    assert.deepEqual([...ts.resolveSlaDays(rows, scope)], [...esm.resolveSlaDays(rows, scope)], JSON.stringify(scope));
    assert.equal(ts.slaScopeKey(scope), esm.slaScopeKey(scope));
  }
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-27T09:00:00Z');
const ago = (d) => new Date(NOW.getTime() - d * DAY);

test('backfill plan: the deadline counts from the stage ENTRY, not from now', () => {
  const plan = esm.planStageDeadline(
    {
      pipelineStatus: 'S',
      startDate: ago(200),
      statusChanges: [
        { fromStatus: 'R', toStatus: 'S', createdAt: ago(90) },
        { fromStatus: 'Q', toStatus: 'R', createdAt: ago(150) },
      ],
    },
    [ORG],
    NOW
  );
  assert.equal(plan.stageDeadline.getTime(), ago(83).getTime());
  assert.equal(plan.pastDue, true, 'parked for 90 days against a 7-day SLA reads overdue');
  assert.equal(plan.enteredFrom, 'statusChange');
});

test('backfill plan: a no-op row does not restart the clock; never moved falls back to startDate', () => {
  const plan = esm.planStageDeadline(
    { pipelineStatus: 'S', startDate: ago(3), statusChanges: [{ fromStatus: 'S', toStatus: 'S', createdAt: ago(1) }] },
    [ORG],
    NOW
  );
  assert.equal(plan.enteredFrom, 'startDate');
  assert.equal(plan.stageDeadline.getTime(), ago(-4).getTime());
  assert.equal(plan.pastDue, false, 'a deadline still ahead is left for the normal reminder');
});

test('backfill plan: the relation\'s own override wins, and no SLA means no write', () => {
  const rel = { pipelineStatus: 'S', startDate: ago(0), statusChanges: [], cohortId: 'c1', mentorId: 'm1' };
  assert.equal(esm.planStageDeadline(rel, [ORG, COHORT], NOW).source, 'cohort');
  assert.equal(esm.planStageDeadline({ ...rel, pipelineStatus: 'X' }, [ORG, COHORT], NOW), null);
});

test('inherited: what applies once the exact-scope row is gone', () => {
  const all = [ORG, COHORT, MENTOR, BOTH];
  assert.deepEqual(ts.inheritedSla(all, { cohortId: 'c1', mentorId: 'm1' }).get('S'), { days: 10, source: 'mentor' });
  assert.deepEqual(ts.inheritedSla(all, { cohortId: 'c1' }).get('S'), { days: 7, source: 'org' });
  assert.equal(ts.inheritedSla([ORG], {}).get('S'), undefined, 'the org row inherits nothing');
});

for (const [name, rule] of [['ts', ts], ['esm', esm]]) {
  test(`${name}: escalation resolves field by field with the same precedence (#3204)`, () => {
    const org = { stageKey: 'S', days: 7, escalateAfterDays: 2 };
    const cohort = { stageKey: 'S', days: 5, cohortId: 'c1', escalateAfterDays: null };
    const mentor = { stageKey: 'S', days: 10, mentorId: 'm1', escalateAfterDays: 4 };
    // Only org rows: exactly the org's rung.
    assert.equal(rule.resolveSlaEscalations([org], { cohortId: 'c1' }).get('S'), 2);
    // A cohort override without its own rung inherits the org's.
    assert.equal(rule.resolveSlaEscalations([org, cohort], { cohortId: 'c1' }).get('S'), 2);
    // A mentor override with its own rung wins.
    assert.equal(rule.resolveSlaEscalations([org, cohort, mentor], { cohortId: 'c1', mentorId: 'm1' }).get('S'), 4);
    // A row without days never escalates.
    assert.equal(rule.resolveSlaEscalations([{ stageKey: 'S', days: null, escalateAfterDays: 3 }], {}).get('S'), undefined);
  });
}
