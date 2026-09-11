// Unit tests for the vertical catalogue (#2350, epic #2348).
//
// WHY THIS FILE EXISTS
//   src/lib/verticals.ts decides which product a tenant is looking at, and the
//   two ways of getting it wrong both type-check:
//
//     • an unknown key resolving to an EMPTY capability set instead of the
//       default blanks a tenant's UI — the failure mode is "the customer's
//       modules disappeared", and it would be reached by a typo, by a key
//       retired while rows still hold it, or by an older container reading a
//       row a newer one wrote mid-deploy;
//     • INTERNSHIP losing a capability switches a live feature off for the only
//       tenant that exists today. Its entry MUST be the full set — that is what
//       makes this slice a no-op in production.
//
//   Neither is reachable from a browser test (nothing branches on a vertical
//   yet — capabilities land in #2351), so both are pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERTICALS,
  VERTICAL_KEYS,
  DEFAULT_VERTICAL,
  isVerticalKey,
  toVerticalKey,
  verticalDefinition,
  verticalCapabilities,
  verticalHasCapability,
} from '../../src/lib/verticals.ts';

test('the catalogue has a unique key per entry and a default that is in it', () => {
  assert.equal(new Set(VERTICAL_KEYS).size, VERTICAL_KEYS.length);
  assert.ok(VERTICAL_KEYS.includes(DEFAULT_VERTICAL));
  assert.equal(VERTICAL_KEYS.length, VERTICALS.length);
});

test('INTERNSHIP carries every capability any vertical declares', () => {
  // The no-op guarantee: today's only tenant is INTERNSHIP, so this slice can
  // only be behaviour-free if its entry is a superset of everything.
  const all = new Set(VERTICALS.flatMap((v) => v.capabilities));
  const internship = new Set(verticalCapabilities('INTERNSHIP'));
  for (const cap of all) {
    assert.ok(internship.has(cap), `INTERNSHIP is missing "${cap}" — that switches a live feature off`);
  }
});

test('MARKETING drops the mentorship-specific modules and keeps the CRM core', () => {
  const caps = verticalCapabilities('MARKETING');
  for (const gone of ['mentorship', 'evaluations', 'placements', 'sourcing']) {
    assert.ok(!caps.includes(gone), `MARKETING should not carry "${gone}"`);
  }
  for (const kept of ['pipeline', 'companies', 'messaging']) {
    assert.ok(caps.includes(kept), `MARKETING needs "${kept}"`);
  }
});

test('an unknown key falls back to the default, never to an empty set', () => {
  for (const bad of ['INTERNSHIPP', 'marketing', '', null, undefined, 42, {}, []]) {
    assert.equal(toVerticalKey(bad), DEFAULT_VERTICAL);
    assert.equal(verticalDefinition(bad).key, DEFAULT_VERTICAL);
    assert.ok(verticalCapabilities(bad).length > 0, 'a fallback that blanks the UI is the bug');
  }
});

test('isVerticalKey is exact — case-sensitive, no coercion', () => {
  assert.ok(isVerticalKey('INTERNSHIP'));
  assert.ok(isVerticalKey('MARKETING'));
  assert.ok(!isVerticalKey('internship'));
  assert.ok(!isVerticalKey('Marketing'));
  assert.ok(!isVerticalKey(' INTERNSHIP'));
  assert.ok(!isVerticalKey(null));
  assert.ok(!isVerticalKey(undefined));
  assert.ok(!isVerticalKey(['INTERNSHIP']));
});

test('capabilities are copies — a caller cannot mutate the catalogue', () => {
  const first = verticalCapabilities('MARKETING');
  first.push('mentorship');
  assert.ok(!verticalCapabilities('MARKETING').includes('mentorship'));
  // And the definition's own array is not the one handed out.
  assert.notEqual(verticalCapabilities('MARKETING'), verticalCapabilities('MARKETING'));
});

test('verticalHasCapability agrees with the capability list, including the fallback', () => {
  assert.ok(verticalHasCapability('INTERNSHIP', 'mentorship'));
  assert.ok(!verticalHasCapability('MARKETING', 'mentorship'));
  // Unknown key answers as the default rather than throwing.
  assert.ok(verticalHasCapability('NOPE', 'mentorship'));
});

test('every entry names a default template, and templates are distinct', () => {
  const templates = VERTICALS.map((v) => v.defaultTemplate);
  for (const tpl of templates) assert.ok(tpl && tpl.trim().length, 'a vertical without a template seeds no stages');
  assert.equal(new Set(templates).size, templates.length);
});
