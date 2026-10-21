'use client';

/**
 * The charting layer (#1890) — `docs/charts.md` records why it is visx.
 *
 * Import charts from here, never from the implementation files: each one is a
 * `next/dynamic` import, so `@visx/*` stays out of a page's first-load bundle
 * the same way `src/lib/excel.ts` keeps `xlsx` out. The box around each chart
 * keeps its height while the chunk loads, so nothing jumps when it arrives.
 *
 * The wrappers own nothing about the domain: they take series that are already
 * shaped and labelled. Colours are CSS values — use the `var(--chart-N)` tokens
 * from globals.css, which light, dark and the org's accent redefine, so a chart
 * never needs a branch per theme.
 */

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import {
  DEFAULT_CHART_HEIGHT,
  type AreaChartProps,
  type BarChartProps,
  type ChartSeries,
  type DonutProps,
  type LineChartProps,
} from './types';

export type { AreaChartProps, BarChartProps, ChartSeries, DonutProps, DonutSlice, LineChartProps } from './types';

const BarChartImpl = dynamic(() => import('./BarChart'), { ssr: false });
const LineChartImpl = dynamic(() => import('./LineChart'), { ssr: false });
const AreaChartImpl = dynamic(() => import('./AreaChart'), { ssr: false });
const DonutImpl = dynamic(() => import('./Donut'), { ssr: false });

function ChartBox({
  height,
  testId,
  className,
  series,
  children,
}: {
  height: number;
  testId?: string;
  className?: string;
  series: ChartSeries<unknown>[];
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <div style={{ height }} data-testid={testId}>
        {children}
      </div>
      {series.length > 1 && <ChartLegend items={series} />}
    </div>
  );
}

/** HTML, not SVG: it wraps on a narrow screen and is read as text. */
export function ChartLegend({ items }: { items: { key: string; label: string; color: string }[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
      {items.map((item) => (
        <span key={item.key} className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function BarChart(props: BarChartProps) {
  const height = props.height ?? DEFAULT_CHART_HEIGHT;
  return (
    <ChartBox height={height} testId={props.testId} className={props.className} series={props.series}>
      <BarChartImpl {...props} height={height} />
    </ChartBox>
  );
}

export function LineChart(props: LineChartProps) {
  const height = props.height ?? DEFAULT_CHART_HEIGHT;
  return (
    <ChartBox height={height} testId={props.testId} className={props.className} series={props.series}>
      <LineChartImpl {...props} height={height} />
    </ChartBox>
  );
}

export function AreaChart(props: AreaChartProps) {
  const height = props.height ?? DEFAULT_CHART_HEIGHT;
  return (
    <ChartBox height={height} testId={props.testId} className={props.className} series={props.series}>
      <AreaChartImpl {...props} height={height} />
    </ChartBox>
  );
}

export function Donut(props: DonutProps) {
  const size = props.size ?? 140;
  return (
    <div className={props.className} style={{ width: size, height: size }} data-testid={props.testId}>
      <DonutImpl {...props} size={size} />
    </div>
  );
}
