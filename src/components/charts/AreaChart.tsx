'use client';

import LineChart from './LineChart';
import type { AreaChartProps } from './types';

/** A LineChart with the area under each line filled (#1890). */
export default function AreaChart(props: AreaChartProps) {
  return <LineChart {...props} area />;
}
