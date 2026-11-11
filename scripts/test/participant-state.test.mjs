// The bench vocabulary (#1778): src/lib/participantState.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBenched, isParticipantState, notBenched, PARTICIPANT_STATES } from '../../src/lib/participantState.ts';

test('two states, a whitelist, never an enum', () => {
  assert.deepEqual([...PARTICIPANT_STATES], ['ACTIVE', 'BENCHED']);
  assert.equal(isParticipantState('BENCHED'), true);
  assert.equal(isParticipantState('benched'), false);
  assert.equal(isParticipantState('INACTIVE'), false);
});

test('isBenched reads only BENCHED; a missing value is active', () => {
  assert.equal(isBenched({ participantState: 'BENCHED' }), true);
  assert.equal(isBenched({ participantState: 'ACTIVE' }), false);
  assert.equal(isBenched({}), false);
  assert.equal(isBenched(null), false);
});

test('notBenched is the one where-fragment for the pools and sweeps', () => {
  assert.deepEqual(notBenched(), { participantState: { not: 'BENCHED' } });
});
