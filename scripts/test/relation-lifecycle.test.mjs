// Unit tests for the relation lifecycle state machine (#1768) —
// src/lib/relationLifecycle.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// What is pinned here is what the rest of the epic (#1767) builds on: the
// derivation of `status` lives in one function, the legal moves are one
// table, a stored row reads the same before and after the deploy backfill,
// and a paused pair is not billable through the ONE allowlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  LIVE_LIFECYCLE_STATES,
  RELATION_LIFECYCLE_STATES,
  LEGAL_TRANSITIONS,
  billableRelationWhere,
  canTransition,
  effectiveLifecycleState,
  isBillable,
  isLive,
  isRelationLifecycleState,
  isTerminal,
  statusForLifecycle,
} = await import('../../src/lib/relationLifecycle.ts');
const { BILLABLE_RELATION_STATES, isBillablePair } = await import('../../src/lib/meteringRules.ts');

test('every state is known, and the pre-#1768 end states are kept', () => {
  for (const s of ['ACTIVE', 'PAUSED', 'COMPLETED', 'ENDED_REMATCHED', 'ENDED_REASSIGNED', 'ENDED_CHURNED']) {
    assert.ok(isRelationLifecycleState(s), s);
  }
  for (const s of ['', null, undefined, 'active', 'BENCHED']) assert.equal(isRelationLifecycleState(s), false);
  assert.deepEqual([...LIVE_LIFECYCLE_STATES], ['ACTIVE', 'PAUSED']);
});

test('statusForLifecycle: ACTIVE and PAUSED are live, everything else is COMPLETED', () => {
  for (const s of RELATION_LIFECYCLE_STATES) {
    assert.equal(statusForLifecycle(s), isLive(s) ? 'ACTIVE' : 'COMPLETED', s);
    assert.equal(isTerminal(s), !isLive(s), s);
  }
  assert.equal(statusForLifecycle('PAUSED'), 'ACTIVE', 'a paused pair keeps every status-ACTIVE reader');
});

test('the derivation is written down in exactly one place', () => {
  const source = readFileSync(new URL('../../src/lib/relationLifecycle.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/export function statusForLifecycle/g) ?? []).length, 1);
});

test('legal moves: ACTIVE ⇄ PAUSED, live → terminal, terminal → ACTIVE only', () => {
  assert.equal(canTransition('ACTIVE', 'PAUSED'), true);
  assert.equal(canTransition('PAUSED', 'ACTIVE'), true);
  assert.equal(canTransition('ACTIVE', 'COMPLETED'), true);
  assert.equal(canTransition('PAUSED', 'COMPLETED'), true);
  assert.equal(canTransition('COMPLETED', 'PAUSED'), false);
  assert.equal(canTransition('COMPLETED', 'ACTIVE'), true, 'the explicit reopen');
  assert.equal(canTransition('ENDED_REMATCHED', 'COMPLETED'), false, 'how a pairing ended is history');
  assert.equal(canTransition('ACTIVE', 'ACTIVE'), false);
  assert.equal(canTransition(null, 'PAUSED'), false);
  assert.equal(canTransition('ACTIVE', 'BENCHED'), false);
  // The table covers every state, and only names known ones.
  assert.deepEqual(Object.keys(LEGAL_TRANSITIONS).sort(), [...RELATION_LIFECYCLE_STATES].sort());
  for (const targets of Object.values(LEGAL_TRANSITIONS)) {
    for (const t of targets) assert.ok(isRelationLifecycleState(t), t);
  }
  // A terminal state goes nowhere but back to ACTIVE.
  for (const s of RELATION_LIFECYCLE_STATES.filter(isTerminal)) assert.deepEqual([...LEGAL_TRANSITIONS[s]], ['ACTIVE']);
});

test('effectiveLifecycleState: status stays authoritative for liveness', () => {
  // Pre-backfill rows (NULL) read as their status says.
  assert.equal(effectiveLifecycleState({ status: 'ACTIVE', lifecycleState: null }), 'ACTIVE');
  assert.equal(effectiveLifecycleState({ status: 'COMPLETED', lifecycleState: null }), 'COMPLETED');
  assert.equal(effectiveLifecycleState({ status: 'COMPLETED' }), 'COMPLETED');
  // The honest end states survive.
  assert.equal(effectiveLifecycleState({ status: 'COMPLETED', lifecycleState: 'ENDED_REMATCHED' }), 'ENDED_REMATCHED');
  assert.equal(effectiveLifecycleState({ status: 'ACTIVE', lifecycleState: 'PAUSED' }), 'PAUSED');
  // A writer that set only `status` cannot make the row lie either way.
  assert.equal(effectiveLifecycleState({ status: 'COMPLETED', lifecycleState: 'ACTIVE' }), 'COMPLETED');
  assert.equal(effectiveLifecycleState({ status: 'COMPLETED', lifecycleState: 'PAUSED' }), 'COMPLETED');
  assert.equal(effectiveLifecycleState({ status: 'ACTIVE', lifecycleState: 'ENDED_REMATCHED' }), 'ACTIVE');
});

test('the backfill writes exactly what effectiveLifecycleState reads', () => {
  const source = readFileSync(new URL('../../prisma/backfill-relation-lifecycle.mjs', import.meta.url), 'utf8');
  assert.match(source, /const LIVE = \['ACTIVE', 'PAUSED'\];/);
  assert.deepEqual([...LIVE_LIFECYCLE_STATES], ['ACTIVE', 'PAUSED'], 'keep the mirror in the backfill in step');
});

test('a paused pair is not billable, through the one allowlist', () => {
  assert.equal(isBillable('PAUSED'), false);
  assert.equal(isBillable('ACTIVE'), true);
  for (const s of RELATION_LIFECYCLE_STATES) {
    assert.equal(isBillable(s), BILLABLE_RELATION_STATES.includes(s), s);
  }
  const busyInMarch = [new Date('2026-03-14T09:00:00Z')];
  const state = effectiveLifecycleState({ status: 'ACTIVE', lifecycleState: 'PAUSED' });
  assert.equal(isBillablePair({ state, activityAt: busyInMarch }, '2026-03'), false);
});

test('billableRelationWhere is the SQL twin: live by status, billable by lifecycle', () => {
  assert.deepEqual(billableRelationWhere(), { status: 'ACTIVE', lifecycleState: { in: ['ACTIVE'] } });
});
