// Geometry shared by the category charts (#1890). No library code here: the
// scales come from `@visx/scale` in the implementations.

export const MARGIN = { top: 16, right: 4, bottom: 20, left: 4 } as const;
/** A bar never grows wider than this, however few categories there are. */
export const MAX_BAR_WIDTH = 24;
export const LABEL_STYLE = { fill: 'var(--chart-label)', fontSize: 10 } as const;

export const defaultFormat = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

/** The top of the value axis: the caller's, else the largest value, at least 1
 *  so an all-zero series draws a flat baseline rather than dividing by zero. */
export function valueMax(yMax: number | undefined, series: { values: (number | null)[] }[]): number {
  if (yMax !== undefined) return yMax;
  let max = 1;
  for (const s of series) for (const v of s.values) if (v !== null && v > max) max = v;
  return max;
}

/** Print every n-th category label so neighbours never overlap on a narrow
 *  screen: twelve months on a phone would otherwise run into each other. */
export function labelStep(count: number, innerWidth: number, minLabelPx = 32): number {
  if (count === 0 || innerWidth <= 0) return 1;
  return Math.max(1, Math.ceil((count * minLabelPx) / innerWidth));
}
