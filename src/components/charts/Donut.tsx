'use client';

import { Group } from '@visx/group';
import { Pie } from '@visx/shape';
import type { DonutProps, DonutSlice } from './types';
import { defaultFormat } from './layout';

/** Parts of a whole as a ring (#1890). A fixed diameter: a donut has no
 *  meaningful aspect to stretch, so it is not measured. */
export default function Donut({ slices, ariaLabel, size = 140, center, formatValue = defaultFormat }: DonutProps) {
  const radius = size / 2;
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  return (
    <svg width={size} height={size} role="img" aria-label={ariaLabel}>
      <Group left={radius} top={radius}>
        {total === 0 ? (
          <circle r={radius - 9} fill="none" stroke="var(--chart-grid)" strokeWidth={18} />
        ) : (
          <Pie<DonutSlice>
            data={slices.filter((s) => s.value > 0)}
            pieValue={(s) => s.value}
            outerRadius={radius}
            innerRadius={radius - 18}
            padAngle={0.01}
          >
            {(pie) =>
              pie.arcs.map((arc) => (
                <path key={arc.data.key} d={pie.path(arc) ?? undefined} fill={arc.data.color} data-value={arc.data.value}>
                  <title>{`${arc.data.label}: ${formatValue(arc.data.value)}`}</title>
                </path>
              ))
            }
          </Pie>
        )}
        {center && (
          <text textAnchor="middle" dominantBaseline="central" style={{ fill: 'var(--chart-label)', fontSize: 16, fontWeight: 600 }}>
            {center}
          </text>
        )}
      </Group>
    </svg>
  );
}
