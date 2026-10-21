'use client';

import { useParentSize } from '@visx/responsive';
import { scaleLinear, scalePoint } from '@visx/scale';
import { Group } from '@visx/group';
import { AreaClosed, LinePath } from '@visx/shape';
import { DEFAULT_CHART_HEIGHT, type LineChartProps } from './types';
import { LABEL_STYLE, MARGIN, labelStep, defaultFormat, valueMax } from './layout';

interface Props extends LineChartProps {
  /** Fill under each line (the AreaChart). */
  area?: boolean;
}

/**
 * A line per series over the categories (#1890), with `null` drawn as a GAP —
 * "no number to state" (an empty month, a window not closed yet) must not read
 * as a fall to zero. Every stated value also gets a dot, so a value with
 * gaps on both sides is still visible.
 */
export default function LineChart({
  categories,
  series,
  height = DEFAULT_CHART_HEIGHT,
  ariaLabel,
  yMax,
  formatValue = defaultFormat,
  showValues = false,
  area = false,
}: Props) {
  const { parentRef, width } = useParentSize({ debounceTime: 50 });
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const step = labelStep(categories.length, innerWidth);

  const x = scalePoint<number>({ domain: categories.map((_, i) => i), range: [0, innerWidth], padding: 0.5 });
  const y = scaleLinear<number>({ domain: [0, valueMax(yMax, series)], range: [innerHeight, 0], clamp: true });
  const indices = categories.map((_, i) => i);

  return (
    <div ref={parentRef} className="h-full w-full">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <Group left={MARGIN.left} top={MARGIN.top}>
            <line x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} stroke="var(--chart-grid)" />
            <line x1={0} x2={innerWidth} y1={0} y2={0} stroke="var(--chart-grid)" strokeDasharray="2 3" />
            {series.map((s) => {
              const defined = (i: number) => s.values[i] !== null && s.values[i] !== undefined;
              const px = (i: number) => x(i) ?? 0;
              const py = (i: number) => y(s.values[i] ?? 0);
              return (
                <g key={s.key}>
                  {area && (
                    <AreaClosed<number>
                      data={indices}
                      x={px}
                      y={py}
                      yScale={y}
                      defined={defined}
                      fill={s.color}
                      fillOpacity={0.15}
                    />
                  )}
                  <LinePath<number> data={indices} x={px} y={py} defined={defined} stroke={s.color} strokeWidth={2} />
                  {indices.filter(defined).map((i) => (
                    <g key={i}>
                      <circle
                        cx={px(i)}
                        cy={py(i)}
                        r={3}
                        fill={s.color}
                        data-testid={s.testIdPrefix ? `${s.testIdPrefix}${i}` : undefined}
                        data-label={categories[i]}
                        data-value={s.values[i] as number}
                      >
                        <title>{`${s.label} · ${categories[i]}: ${formatValue(s.values[i] as number)}`}</title>
                      </circle>
                      {showValues && (
                        <text x={px(i)} y={py(i) - 7} textAnchor="middle" style={{ ...LABEL_STYLE, fontWeight: 500 }}>
                          {formatValue(s.values[i] as number)}
                        </text>
                      )}
                    </g>
                  ))}
                </g>
              );
            })}
            {categories.map((category, i) => i % step === 0 && (
              <text key={i} x={x(i) ?? 0} y={innerHeight + 14} textAnchor="middle" style={LABEL_STYLE}>
                {category}
              </text>
            ))}
          </Group>
        </svg>
      )}
    </div>
  );
}
