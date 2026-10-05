// Unit tests for the mentor's private "your impact" counts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// What these pin down:
//   - outcome and internship membership come from the TENANT'S stages, never a
//     hardcoded HIRED_660 (a renamed pipeline must still count);
//   - "reached" means EVER reached: a person hired and then moved on still
//     counts, read from both ends of each recorded stage move;
//   - a handover is not a visit: a relation that continues a predecessor does
//     not credit its new mentor with the stage it inherited (#2289);
//   - people, not relations: one person mentored twice is one person;
//   - a pipeline with no internship stage reports null, not a guessed number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMentorImpact,
  internshipOrBeyondKeys,
  stagesVisited,
} from '../../src/lib/mentorImpactRule.ts';

// The catalogue's internship phase, as PIPELINE_GROUPS lists it.
const PHASE = ['INTERNSHIP_STARTING_300', 'INTERNSHIP_IN_PROGRESS_450', 'INTERNSHIP_DROPPED_460', 'INTERNSHIP_COMPLETED_490'];

const CANONICAL = [
  ['APPLICATION_100', false],
  ['APPROVAL_PENDING_220', false],
  ['INTERVIEW_PENDING_250', false],
  ['INTRODUCTION_PENDING_270', false],
  ['INTERNSHIP_STARTING_300', false],
  ['INTERNSHIP_IN_PROGRESS_450', false],
  ['INTERNSHIP_DROPPED_460', true],
  ['INTERNSHIP_COMPLETED_490', false],
  ['JOB_SEEKING_500', false],
  ['HIREABLE_600', false],
  ['HIRED_660', false],
  ['EMPLOYED_700', false],
  ['INTERNSHIP_FOUND_ELSEWHERE_800', true],
].map(([key, isOffPath], order) => ({ key, order, isOffPath }));

const FINISHED = ['HIRED_660', 'EMPLOYED_700'];

// moves: [[from, to], ...]
const rel = (menteeId, pipelineStatus, moves = [], status = 'ACTIVE', startsInherited = false) => ({
  menteeId,
  status,
  pipelineStatus,
  moves: moves.map(([fromStatus, toStatus]) => ({ fromStatus, toStatus })),
  startsInherited,
});

test('canonical internship-or-beyond: the phase, everything on-path after it, never "found elsewhere"', () => {
  const keys = internshipOrBeyondKeys(CANONICAL, PHASE);
  assert.deepEqual(keys, [
    'INTERNSHIP_STARTING_300',
    'INTERNSHIP_IN_PROGRESS_450',
    'INTERNSHIP_DROPPED_460',
    'INTERNSHIP_COMPLETED_490',
    'JOB_SEEKING_500',
    'HIREABLE_600',
    'HIRED_660',
    'EMPLOYED_700',
  ]);
  assert.ok(!keys.includes('INTERNSHIP_FOUND_ELSEWHERE_800'));
  assert.ok(!keys.includes('INTRODUCTION_PENDING_270'));
});

test('a pipeline with no internship stage reports null instead of guessing', () => {
  const custom = ['STAGE_A', 'STAGE_B', 'STAGE_C'].map((key, order) => ({ key, order, isOffPath: false }));
  assert.equal(internshipOrBeyondKeys(custom, PHASE), null);
  const impact = computeMentorImpact([rel('m1', 'STAGE_C')], { finishedKeys: ['STAGE_C'], internshipKeys: null });
  assert.equal(impact.reachedInternship, null);
  assert.equal(impact.reachedOutcome, 1);
});

test('a tenant that inserted its own stage after the internship counts it as beyond', () => {
  const stages = [
    { key: 'APPLICATION_100', order: 0, isOffPath: false },
    { key: 'INTERNSHIP_IN_PROGRESS_450', order: 1, isOffPath: false },
    { key: 'PORTFOLIO_REVIEW', order: 2, isOffPath: false },
    { key: 'WITHDREW', order: 3, isOffPath: true },
    { key: 'OFFER_SIGNED', order: 4, isOffPath: false },
  ];
  assert.deepEqual(internshipOrBeyondKeys(stages, PHASE), ['INTERNSHIP_IN_PROGRESS_450', 'PORTFOLIO_REVIEW', 'OFFER_SIGNED']);
});

test('an off-path internship stage alone still counts, but anchors nothing', () => {
  const stages = [
    { key: 'APPLICATION_100', order: 0, isOffPath: false },
    { key: 'INTERNSHIP_DROPPED_460', order: 1, isOffPath: true },
    { key: 'DONE', order: 2, isOffPath: false },
  ];
  assert.deepEqual(internshipOrBeyondKeys(stages, PHASE), ['INTERNSHIP_DROPPED_460']);
});

test('the four counts on the canonical catalogue', () => {
  const internshipKeys = internshipOrBeyondKeys(CANONICAL, PHASE);
  const impact = computeMentorImpact(
    [
      rel('a', 'APPLICATION_100'),
      rel('b', 'INTERNSHIP_IN_PROGRESS_450', [
        ['APPLICATION_100', 'INTERNSHIP_STARTING_300'],
        ['INTERNSHIP_STARTING_300', 'INTERNSHIP_IN_PROGRESS_450'],
      ]),
      rel('c', 'HIRED_660', [['HIREABLE_600', 'HIRED_660']], 'COMPLETED'),
      rel('d', 'INTERNSHIP_FOUND_ELSEWHERE_800', [['INTERVIEW_PENDING_250', 'INTERNSHIP_FOUND_ELSEWHERE_800']], 'COMPLETED'),
    ],
    { finishedKeys: FINISHED, internshipKeys },
  );
  assert.deepEqual(impact, { mentored: 4, active: 2, reachedInternship: 2, reachedOutcome: 1 });
});

test('hired and then moved on still counts as reached — read from history', () => {
  // Moved from HIRED_660 back out (a later off-path move, say): the current
  // stage is not an outcome, but the history says the person got there.
  const internshipKeys = internshipOrBeyondKeys(CANONICAL, PHASE);
  const impact = computeMentorImpact(
    [rel('a', 'INTERNSHIP_FOUND_ELSEWHERE_800', [['HIRED_660', 'INTERNSHIP_FOUND_ELSEWHERE_800']], 'COMPLETED')],
    { finishedKeys: FINISHED, internshipKeys },
  );
  assert.equal(impact.reachedOutcome, 1);
  assert.equal(impact.reachedInternship, 1);
  assert.equal(impact.active, 0);
});

test('the starting stage of a relation is visited even though nothing moved INTO it', () => {
  assert.deepEqual(
    [...stagesVisited({ pipelineStatus: 'X', moves: [{ fromStatus: 'START', toStatus: 'X' }] })].sort(),
    ['START', 'X'],
  );
});

test('a handover successor credits only the stages entered by moves on it', () => {
  // Inherited at START, then moved to X: START belongs to the previous mentor.
  assert.deepEqual(
    [...stagesVisited({ pipelineStatus: 'X', moves: [{ fromStatus: 'START', toStatus: 'X' }], startsInherited: true })],
    ['X'],
  );
  // Inherited and never moved: nothing was reached under the new mentor.
  assert.deepEqual([...stagesVisited({ pipelineStatus: 'X', moves: [], startsInherited: true })], []);
});

test('transferred at HIRED_660: the new mentor gets 0, the old mentor keeps 1', () => {
  const rule = { finishedKeys: FINISHED, internshipKeys: internshipOrBeyondKeys(CANONICAL, PHASE) };
  // Old mentor: walked the person to HIRED_660, relation then ended by the handover.
  const oldMentor = computeMentorImpact(
    [rel('p', 'HIRED_660', [['INTERNSHIP_COMPLETED_490', 'HIRED_660']], 'COMPLETED')],
    rule,
  );
  assert.equal(oldMentor.reachedOutcome, 1);
  assert.equal(oldMentor.reachedInternship, 1);
  // New mentor: the successor relation starts on HIRED_660 with no move of its own.
  const newMentor = computeMentorImpact([rel('p', 'HIRED_660', [], 'ACTIVE', true)], rule);
  assert.deepEqual(newMentor, { mentored: 1, active: 1, reachedInternship: 0, reachedOutcome: 0 });
});

test('a handover successor that moves on (and back) counts what it entered itself', () => {
  const rule = { finishedKeys: FINISHED, internshipKeys: internshipOrBeyondKeys(CANONICAL, PHASE) };
  // Inherited at an interview stage, then placed in an internship under the new mentor.
  const placed = computeMentorImpact(
    [rel('q', 'INTERNSHIP_STARTING_300', [['INTERVIEW_PENDING_250', 'INTERNSHIP_STARTING_300']], 'ACTIVE', true)],
    rule,
  );
  assert.equal(placed.reachedInternship, 1);
  assert.equal(placed.reachedOutcome, 0);
  // Inherited at HIRED_660, left it, and was hired again under the new mentor.
  const rehired = computeMentorImpact(
    [rel('r', 'HIRED_660', [['HIRED_660', 'JOB_SEEKING_500'], ['JOB_SEEKING_500', 'HIRED_660']], 'ACTIVE', true)],
    rule,
  );
  assert.equal(rehired.reachedOutcome, 1);
});

test('people, not relations: one person mentored twice is counted once', () => {
  const impact = computeMentorImpact(
    [
      rel('same', 'HIRED_660', [], 'COMPLETED'),
      rel('same', 'APPLICATION_100', [], 'ACTIVE'),
    ],
    { finishedKeys: FINISHED, internshipKeys: internshipOrBeyondKeys(CANONICAL, PHASE) },
  );
  assert.deepEqual(impact, { mentored: 1, active: 1, reachedInternship: 1, reachedOutcome: 1 });
});

test('a renamed pipeline counts its own finished stage, not HIRED_660', () => {
  const impact = computeMentorImpact(
    [rel('a', 'STAGE_F', [['STAGE_A', 'STAGE_F']]), rel('b', 'HIRED_660')],
    { finishedKeys: ['STAGE_F'], internshipKeys: null },
  );
  // 'HIRED_660' is not a stage of this tenant: it must not count.
  assert.equal(impact.reachedOutcome, 1);
});

test('no relations: all zero (the card itself is not rendered then)', () => {
  assert.deepEqual(computeMentorImpact([], { finishedKeys: FINISHED, internshipKeys: [] }), {
    mentored: 0,
    active: 0,
    reachedInternship: 0,
    reachedOutcome: 0,
  });
});
