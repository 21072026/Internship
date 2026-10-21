'use client';

import { useParentSize } from '@visx/responsive';
import { scaleBand, scaleLinear } from '@visx/scale';
import { Group } from '@visx/group';
import { Bar } from '@visx/shape';
import { DEFAULT_CHART_HEIGHT, type BarChartProps } from './types';
import { LABEL_STYLE, MARGIN, labelStep, MAX_BAR_WIDTH, defaultFormat, valueMax } from './layout';

/**
 * Grouped bars, one group per category (#1890). Loaded through `index.tsx`.
 *
 * The bars are SVG rects whose pixel heights come from a scale over the
 * MEASURED width and the given height — there is no CSS percentage left to
 * resolve against an indefinite parent, which is what collapsed the old
 * hand-rolled track to 0px (#1425). The width is read by a ResizeObserver, so a
 * viewport resize or a client-side navigation into the page re-measures rather
 * than keeping whatever the first layout pass saw.
 */
export default function BarChart({
  categories,
  series,
  height = DEFAULT_CHART_HEIGHT,
  ariaLabel,
  yMax,
  formatValue = defaultFormat,
  showValues = false,
}: BarChartProps) {
  const { parentRef, width } = useParentSize({ debounceTime: 50 });
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const step = labelStep(categories.length, innerWidth);

  const x0 = scaleBand<number>({ domain: categories.map((_, i) => i), range: [0, innerWidth], padding: 0.2 });
  const x1 = scaleBand<string>({ domain: series.map((s) => s.key), range: [0, x0.bandwidth()], padding: 0.15 });
  const y = scaleLinear<number>({ domain: [0, valueMax(yMax, series)], range: [innerHeight, 0], clamp: true });
  const barWidth = Math.min(MAX_BAR_WIDTH, x1.bandwidth());

  return (
    <div ref={parentRef} className="h-full w-full">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <Group left={MARGIN.left} top={MARGIN.top}>
            <line x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} stroke="var(--chart-grid)" />
            {categories.map((category, i) => {
              const groupX = x0(i) ?? 0;
              return (
                <Group key={i} left={groupX}>
                  {series.map((s) => {
                    const value = s.values[i] ?? 0;
                    const barHeight = innerHeight - y(value);
                    const barX = (x1(s.key) ?? 0) + (x1.bandwidth() - barWidth) / 2;
                    return (
                      <g key={s.key}>
                        <Bar
                          x={barX}
                          y={innerHeight - barHeight}
                          width={barWidth}
                          height={barHeight}
                          rx={2}
                          fill={s.color}
                          data-testid={s.testIdPrefix ? `${s.testIdPrefix}${i}` : undefined}
                          data-label={category}
                          data-value={value}
                        >
                          <title>{`${s.label} · ${category}: ${formatValue(value)}`}</title>
                        </Bar>
                        {showValues && (
                          <text
                            x={barX + barWidth / 2}
                            y={innerHeight - barHeight - 4}
                            textAnchor="middle"
                            style={{ ...LABEL_STYLE, fontWeight: 500 }}
                          >
                            {formatValue(value)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                  {i % step === 0 && (
                    <text x={x0.bandwidth() / 2} y={innerHeight + 14} textAnchor="middle" style={LABEL_STYLE}>
                      {category}
                    </text>
                  )}
                </Group>
              );
            })}
          </Group>
        </svg>
      )}
    </div>
  );
}
