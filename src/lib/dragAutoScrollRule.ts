// How fast a board scrolls sideways while a card is dragged near its edge
// (#3662). The browser's native drag-and-drop does not scroll an inner
// horizontal scroller, so a card could not reach a stage that was off-screen
// ("Won", "Lost" on the sales funnel) without first dropping it somewhere else.
//
// Pure, so the numbers are unit-tested (scripts/test/drag-auto-scroll.test.mjs);
// HorizontalScrollArea applies the step once per animation frame.

/** Width of the hot zone at each edge, in CSS pixels (shrinks on a narrow scroller). */
export const DRAG_SCROLL_EDGE = 80;
/** Pixels per frame at the very edge — ~1200 px/s at 60 fps. */
export const DRAG_SCROLL_MAX_STEP = 20;

/**
 * Horizontal scroll step for a pointer at `x` over a scroller spanning
 * `left`..`right` (viewport coordinates): negative scrolls left, positive
 * right, 0 outside both edge zones. The speed grows linearly towards the edge,
 * and a pointer past the edge scrolls at full speed.
 */
export function dragAutoScrollStep(
  x: number,
  left: number,
  right: number,
  edge: number = DRAG_SCROLL_EDGE,
  maxStep: number = DRAG_SCROLL_MAX_STEP,
): number {
  const width = right - left;
  if (!(width > 0) || !Number.isFinite(x)) return 0;
  // Two zones that meet in the middle would leave no place to stand still.
  const zone = Math.min(edge, width / 4);
  if (zone <= 0) return 0;
  const intoLeft = left + zone - x;
  if (intoLeft > 0) return -Math.max(1, Math.round(maxStep * Math.min(1, intoLeft / zone)));
  const intoRight = x - (right - zone);
  if (intoRight > 0) return Math.max(1, Math.round(maxStep * Math.min(1, intoRight / zone)));
  return 0;
}
