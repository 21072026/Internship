// The props of the chart wrappers (#1890). Kept apart from the implementations
// so a page can name these types without pulling the chart library into its
// own bundle — only `index.tsx`'s dynamic imports reach `@visx/*`.

/** One named series over the chart's categories, value i ↔ category i. */
export interface ChartSeries<V = number> {
  key: string;
  label: string;
  /** Any CSS colour; normally a `var(--chart-N)` token from globals.css, so the
   *  chart follows light/dark and the org's accent with no branch of its own. */
  color: string;
  values: V[];
  /** Each mark gets `data-testid={testIdPrefix + i}`. */
  testIdPrefix?: string;
}

interface CategoryChartProps {
  /** Labels along the x axis, already formatted for the reader. */
  categories: string[];
  /** Plot height in px. The width follows the container. */
  height?: number;
  /** What the chart shows, for a screen reader (the svg is one `img`). */
  ariaLabel: string;
  /** Top of the value axis; defaults to the largest value (at least 1). */
  yMax?: number;
  formatValue?: (value: number) => string;
  /** Print each value above its mark. */
  showValues?: boolean;
  /** On the outer box, which keeps its height while the library loads. */
  testId?: string;
  className?: string;
}

export interface BarChartProps extends CategoryChartProps {
  series: ChartSeries<number>[];
}

/** `null` is "no number to state" — a gap in the line, never a zero. */
export interface LineChartProps extends CategoryChartProps {
  series: ChartSeries<number | null>[];
}

export type AreaChartProps = LineChartProps;

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface DonutProps {
  slices: DonutSlice[];
  ariaLabel: string;
  /** Diameter in px. */
  size?: number;
  /** Printed in the hole, e.g. the total or a rate. */
  center?: string;
  formatValue?: (value: number) => string;
  testId?: string;
  className?: string;
}

export const DEFAULT_CHART_HEIGHT = 160;
