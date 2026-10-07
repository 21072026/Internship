// The Application state machine and its authorization rule (#1828).
// Run: node --test --experimental-strip-types scripts/test/applications.test.mjs
//
// Three things a reviewer cannot keep in their head: the transition table is
// forward-only and every open stage can be rejected or withdrawn; the one
// authorization rule refuses what each role must not do; and the plain-ESM
// mirror the deploy backfill runs (scripts/applications-backfill-lib.mjs) says
// exactly what src/lib/applications.ts says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLICATION_SOURCES,
  APPLICATION_STAGES,
  APPLICATION_STATUSES,
  COMPANY_TARGET_STAGES,
  DISPOSITION_CODES,
  INTEREST_STAGE,
  TERMINAL_STAGES,
  applicationFromInterest,
  canPerformApplicationAction,
  canTransition,
  isApplicationSource,
  isApplicationStage,
  isDispositionCode,
  isTerminalStage,
  nextStages,
  requiresDispositionCode,
  statusForStage,
} from '../../src/lib/applications.ts';
import * as mirror from '../applications-backfill-lib.mjs';

test('the vocabulary is the one the issue fixed', () => {
  assert.deepEqual([...APPLICATION_STAGES], ['APPLIED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN']);
  assert.deepEqual([...DISPOSITION_CODES], ['SKILLS', 'EXPERIENCE', 'LANGUAGE', 'LOCATION', 'AVAILABILITY', 'ROLE_FILLED', 'OTHER']);
  assert.deepEqual([...APPLICATION_SOURCES], ['SELF', 'SHORTLIST', 'ADMIN']);
  assert.deepEqual([...APPLICATION_STATUSES], ['ACTIVE', 'HIRED', 'REJECTED', 'WITHDRAWN']);
  assert.ok(isApplicationStage('OFFER') && !isApplicationStage('offer') && !isApplicationStage('HIRED_660'));
  assert.ok(isDispositionCode('ROLE_FILLED') && !isDispositionCode(''));
  assert.ok(isApplicationSource('SHORTLIST') && !isApplicationSource('IMPORT'));
});

test('the funnel moves forward: the happy path is legal, APPLIED -> HIRED is not', () => {
  const path = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'OFFER', 'HIRED'];
  for (let i = 1; i < path.length; i++) assert.ok(canTransition(path[i - 1], path[i]), `${path[i - 1]} -> ${path[i]}`);
  assert.equal(canTransition('APPLIED', 'HIRED'), false);
  assert.equal(canTransition('SCREENING', 'OFFER'), false);
  assert.equal(canTransition('SHORTLISTED', 'HIRED'), false);
  // Nothing moves backwards.
  assert.equal(canTransition('INTERVIEW', 'SHORTLISTED'), false);
  assert.equal(canTransition('OFFER', 'APPLIED'), false);
  // Unknown strings never pass.
  assert.equal(canTransition('APPLIED', 'applied'), false);
  assert.equal(canTransition('', 'SCREENING'), false);
  assert.equal(canTransition('APPLIED', 'APPLIED'), false);
});

test('every open stage can be rejected or withdrawn; terminal stages have no outgoing edge', () => {
  for (const stage of APPLICATION_STAGES) {
    if (isTerminalStage(stage)) {
      assert.deepEqual(nextStages(stage), [], `${stage} must be terminal`);
      assert.equal(statusForStage(stage), stage);
      continue;
    }
    assert.ok(canTransition(stage, 'REJECTED'), `${stage} -> REJECTED`);
    assert.ok(canTransition(stage, 'WITHDRAWN'), `${stage} -> WITHDRAWN`);
    assert.equal(statusForStage(stage), 'ACTIVE');
  }
  assert.deepEqual([...TERMINAL_STAGES], ['HIRED', 'REJECTED', 'WITHDRAWN']);
  assert.deepEqual(nextStages('nope'), []);
  assert.ok(requiresDispositionCode('REJECTED'));
  assert.ok(!requiresDispositionCode('WITHDRAWN') && !requiresDispositionCode('HIRED'));
});

test('one authorization rule: who may move an application where', () => {
  const base = { isOwnApplication: false, isOwningCompany: false };
  // ADMIN: every legal transition, no illegal one.
  assert.ok(canPerformApplicationAction({ ...base, role: 'ADMIN', from: 'OFFER', to: 'HIRED' }));
  assert.ok(!canPerformApplicationAction({ ...base, role: 'ADMIN', from: 'APPLIED', to: 'HIRED' }));
  // MENTOR: only for a mentee they actively mentor.
  assert.ok(canPerformApplicationAction({ ...base, role: 'MENTOR', isMenteesMentor: true, from: 'SHORTLISTED', to: 'INTERVIEW' }));
  assert.ok(!canPerformApplicationAction({ ...base, role: 'MENTOR', from: 'SHORTLISTED', to: 'INTERVIEW' }));
  assert.ok(!canPerformApplicationAction({ ...base, role: 'MENTOR', isMenteesMentor: false, from: 'SHORTLISTED', to: 'INTERVIEW' }));
  // MENTEE: own application, withdraw only.
  assert.ok(canPerformApplicationAction({ ...base, role: 'MENTEE', isOwnApplication: true, from: 'APPLIED', to: 'WITHDRAWN' }));
  assert.ok(!canPerformApplicationAction({ ...base, role: 'MENTEE', isOwnApplication: true, from: 'APPLIED', to: 'SHORTLISTED' }));
  assert.ok(!canPerformApplicationAction({ ...base, role: 'MENTEE', isOwnApplication: false, from: 'APPLIED', to: 'WITHDRAWN' }));
  // COMPANY: own requisition only, and only screen / shortlist / reject.
  assert.deepEqual([...COMPANY_TARGET_STAGES], ['SCREENING', 'SHORTLISTED', 'REJECTED']);
  assert.ok(canPerformApplicationAction({ ...base, role: 'COMPANY', isOwningCompany: true, from: 'APPLIED', to: 'SHORTLISTED' }));
  assert.ok(canPerformApplicationAction({ ...base, role: 'COMPANY', isOwningCompany: true, from: 'INTERVIEW', to: 'REJECTED' }));
  assert.ok(!canPerformApplicationAction({ ...base, role: 'COMPANY', isOwningCompany: false, from: 'APPLIED', to: 'SHORTLISTED' }));
  assert.ok(!canPerformApplicationAction({ ...base, role: 'COMPANY', isOwningCompany: true, from: 'SHORTLISTED', to: 'INTERVIEW' }));
  assert.ok(!canPerformApplicationAction({ ...base, role: 'COMPANY', isOwningCompany: true, from: 'OFFER', to: 'HIRED' }));
  assert.ok(!canPerformApplicationAction({ ...base, role: 'COMPANY', isOwningCompany: true, from: 'APPLIED', to: 'WITHDRAWN' }));
  // A role the rule does not know gets nothing, even an "own" flag.
  assert.ok(!canPerformApplicationAction({ role: 'SUPPORT', isOwnApplication: true, isOwningCompany: true, isMenteesMentor: true, from: 'APPLIED', to: 'SCREENING' }));
});

const interestCorpus = [
  { requisitionId: 'req1', menteeId: 'm1', companyId: 'c1', status: 'INTERESTED', note: null },
  { requisitionId: 'req1', menteeId: 'm2', companyId: 'c1', status: 'SHORTLISTED', note: 'strong' },
  { requisitionId: 'req2', menteeId: 'm1', companyId: 'c2', status: 'PASS', note: '  not this role  ' },
  { requisitionId: 'req2', menteeId: 'm3', companyId: 'c2', status: 'PASS', note: '' },
  { requisitionId: 'req2', menteeId: 'm4', companyId: 'c2', status: 'PASS' },
  { requisitionId: null, menteeId: 'm1', companyId: 'c1', status: 'SHORTLISTED', note: 'legacy' },
  { requisitionId: 'req3', menteeId: 'm5', companyId: 'c3', status: 'MAYBE', note: null },
];

test('the bridge from CompanyInterest: a shortlist is an application, a legacy interest is not', () => {
  assert.deepEqual(INTEREST_STAGE, { INTERESTED: 'SCREENING', SHORTLISTED: 'SHORTLISTED', PASS: 'REJECTED' });
  const shortlisted = applicationFromInterest(interestCorpus[1]);
  assert.deepEqual(shortlisted, {
    requisitionId: 'req1', menteeId: 'm2', companyId: 'c1', source: 'SHORTLIST',
    stage: 'SHORTLISTED', status: 'ACTIVE', dispositionCode: null, dispositionNote: null,
  });
  const passed = applicationFromInterest(interestCorpus[2]);
  assert.equal(passed?.stage, 'REJECTED');
  assert.equal(passed?.status, 'REJECTED');
  assert.equal(passed?.dispositionCode, 'OTHER');
  assert.equal(passed?.dispositionNote, 'not this role');
  assert.equal(applicationFromInterest(interestCorpus[3])?.dispositionNote, null);
  assert.equal(applicationFromInterest(interestCorpus[5]), null, 'no requisition, no application');
  assert.equal(applicationFromInterest(interestCorpus[6]), null, 'an unknown flag maps to nothing');
});

test('the deploy backfill mirror says what the TypeScript rule says', () => {
  for (const interest of interestCorpus) {
    assert.deepEqual(mirror.interestToApplication(interest), applicationFromInterest(interest), JSON.stringify(interest));
  }
  assert.deepEqual(mirror.INTEREST_STAGE, INTEREST_STAGE);
  for (const stage of APPLICATION_STAGES) assert.equal(mirror.statusForStage(stage), statusForStage(stage));
});
