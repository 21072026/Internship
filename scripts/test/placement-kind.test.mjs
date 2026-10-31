// Unit tests for the relation-kind / employment-attribution vocabulary (#1503).
//
// Run: node --test --experimental-strip-types scripts/test/placement-kind.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RELATION_KIND,
  funnelEnteredAtForKindChange,
  isEmploymentAttribution,
  isRelationKind,
} from '../../src/lib/placementKind.ts';

test('kind and attribution are whitelists', () => {
  assert.equal(DEFAULT_RELATION_KIND, 'PLACEMENT');
  for (const ok of ['PLACEMENT', 'COACHING']) assert.ok(isRelationKind(ok));
  for (const bad of ['placement', 'OTHER', '', null, 3]) assert.ok(!isRelationKind(bad));
  for (const ok of ['THROUGH_US', 'SELF_FOUND', 'ALREADY_EMPLOYED']) assert.ok(isEmploymentAttribution(ok));
  for (const bad of ['UNSPECIFIED', 'through_us', '', undefined]) assert.ok(!isEmploymentAttribution(bad));
});

test('a kind change stamps or clears funnelEnteredAt, a no-op leaves it', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  assert.equal(funnelEnteredAtForKindChange('COACHING', 'PLACEMENT', now), now);
  assert.equal(funnelEnteredAtForKindChange('PLACEMENT', 'COACHING', now), null);
  assert.equal(funnelEnteredAtForKindChange('PLACEMENT', 'PLACEMENT', now), undefined);
});

// #1505: time to hire is measured from the moment the relation ENTERED the
// funnel. A coaching pair that turned into a job search months later must not
// carry the coaching months into the number; a row with no stamp (before #1503)
// reads exactly as it did, from its startDate.
test('a journey starts at funnel entry, and a row without one at its startDate', async () => {
  const { register } = await import('node:module');
  register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
  const { funnelStartedAt } = await import('../../src/lib/placement.ts');
  const { timeToHire } = await import('../../src/lib/funnelKpi.ts');

  const start = new Date('2026-01-01T00:00:00Z');
  const entered = new Date('2026-05-01T00:00:00Z');
  const hiredAt = new Date('2026-06-01T00:00:00Z').getTime();
  assert.equal(funnelStartedAt({ startDate: start, funnelEnteredAt: entered }), entered);
  assert.equal(funnelStartedAt({ startDate: start, funnelEnteredAt: null }), start);
  assert.equal(funnelStartedAt({ startDate: start }), start);

  const order = ['APPLICATION_100', 'HIRED_660'];
  const journey = (r) => ({ startStatus: 'APPLICATION_100', startedAt: funnelStartedAt(r).getTime(), changes: [{ toStatus: 'HIRED_660', at: hiredAt }] });
  // Entered in May, hired in June: 31 days, not the 151 since the pairing.
  assert.equal(timeToHire(order, [journey({ startDate: start, funnelEnteredAt: entered })]).medianDays, 31);
  // No stamp: unchanged, from the pairing.
  assert.equal(timeToHire(order, [journey({ startDate: start, funnelEnteredAt: null })]).medianDays, 151);
});
