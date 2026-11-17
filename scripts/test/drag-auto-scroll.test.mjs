// Unit tests for the board's drag auto-scroll step (#3662): a card dragged to
// a scroller's edge must scroll it, the middle must not, and the speed must
// grow towards the edge — a wrong sign or a dead zone fails only by feel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragAutoScrollStep, DRAG_SCROLL_MAX_STEP } from '../../src/lib/dragAutoScrollRule.ts';

test('the middle of the scroller does not scroll', () => {
  assert.equal(dragAutoScrollStep(500, 0, 1000), 0);
  assert.equal(dragAutoScrollStep(100, 0, 1000), 0);
  assert.equal(dragAutoScrollStep(900, 0, 1000), 0);
});

test('near the right edge scrolls right, near the left edge scrolls left', () => {
  assert.ok(dragAutoScrollStep(990, 0, 1000) > 0);
  assert.ok(dragAutoScrollStep(10, 0, 1000) < 0);
});

test('the step grows towards the edge and caps at the maximum', () => {
  const near = dragAutoScrollStep(930, 0, 1000);
  const nearer = dragAutoScrollStep(980, 0, 1000);
  assert.ok(nearer > near, `${nearer} > ${near}`);
  assert.equal(dragAutoScrollStep(1000, 0, 1000), DRAG_SCROLL_MAX_STEP);
  assert.equal(dragAutoScrollStep(1400, 0, 1000), DRAG_SCROLL_MAX_STEP);
  assert.equal(dragAutoScrollStep(-50, 0, 1000), -DRAG_SCROLL_MAX_STEP);
});

test('just inside a zone still moves', () => {
  assert.equal(dragAutoScrollStep(920.5, 0, 1000), 1);
});

test('a narrow scroller keeps a still middle', () => {
  // 200px wide: zones shrink to 50px each, so x=100 stays put.
  assert.equal(dragAutoScrollStep(100, 0, 200), 0);
  assert.ok(dragAutoScrollStep(190, 0, 200) > 0);
});

test('a degenerate box or pointer never scrolls', () => {
  assert.equal(dragAutoScrollStep(10, 100, 100), 0);
  assert.equal(dragAutoScrollStep(Number.NaN, 0, 1000), 0);
});
