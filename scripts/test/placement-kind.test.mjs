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
