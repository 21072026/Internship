// Stage entry gates (#1589) — the pure half. No Next, no DB.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const { gatedTarget, gateCapability, hasGate } = await import('../../src/lib/stageGateRule.ts');

const stages = [
  { key: 'A', order: 0, isOffPath: false },
  { key: 'B', order: 1, isOffPath: false, gateDocuments: true },
  { key: 'C', order: 2, isOffPath: false, gateCapability: 'pipeline.transition' },
  { key: 'D', order: 3, isOffPath: true, gateOffer: true },
  { key: 'E', order: 4, isOffPath: false },
];

test('a stage with no configured gate is open', () => {
  assert.equal(gatedTarget(stages, 'A', 'E'), null);
  assert.equal(hasGate({ gateCapability: null, gateDocuments: false, gateEvaluation: false, gateOffer: false }), false);
  assert.equal(hasGate({ gateCapability: '  ' }), true, 'a blank-but-present capability still counts as configured; gateCapability() reads it as none');
});

test('a forward move into a gated stage is gated', () => {
  assert.equal(gatedTarget(stages, 'A', 'B')?.key, 'B');
  assert.equal(gatedTarget(stages, 'A', 'C')?.key, 'C', 'skipping ahead does not dodge the gate');
});

test('a backwards or same-stage move is never gated', () => {
  assert.equal(gatedTarget(stages, 'C', 'B'), null);
  assert.equal(gatedTarget(stages, 'B', 'B'), null);
  assert.equal(gatedTarget(stages, 'E', 'C'), null);
});

test('an off-path stage is never gated, whatever it is configured with', () => {
  assert.equal(gatedTarget(stages, 'A', 'D'), null);
});

test('an unknown target is open; an unknown current stage counts as before everything', () => {
  assert.equal(gatedTarget(stages, 'A', 'NOPE'), null);
  assert.equal(gatedTarget(stages, 'LEGACY', 'B')?.key, 'B');
});

test('an org on the built-in stages (no rows) gates nothing', () => {
  assert.equal(gatedTarget([], 'APPLICATION_100', 'HIRED_660'), null);
});

test('the capability: a Permission, none, or fail-closed', () => {
  assert.equal(gateCapability({ gateCapability: 'pipeline.transition' }), 'pipeline.transition');
  assert.equal(gateCapability({ gateCapability: null }), null);
  assert.equal(gateCapability({ gateCapability: ' ' }), null);
  assert.equal(gateCapability({ gateCapability: 'pipeline.transiton' }), 'invalid');
});
