import type { UsagePoint } from '@/lib/usageRule';
import { usageSummary } from '@/lib/usageRule';
import type { Dictionary } from '@/i18n/dictionaries';

// An account's daily product usage, last 90 days (#2448). The house chart
// convention, not a library and not SVG: CSS-height bars inside a fixed-pixel
// track (the percentage heights need a definite parent — the reason
// BAR_AREA_PX exists in src/app/admin/analytics/page.tsx), one data-testid per
// bar. A day with a zero row and a day with no row look different and read
// differently: "0" is a customer who did nothing, "no data" is a feed gap.

const TRACK_PX = 48;

export function UsageSparkline({ series, labels }: { series: UsagePoint[]; labels: Dictionary['companyDetail']['usage'] }) {
  const s = usageSummary(series);
  const scale = s.max > 0 ? s.max : 1;
  const fmt = (n: number | null) => (n === null ? '—' : String(n));
  const summary = labels.summary
    .replace('{days}', String(s.daysWithData))
    .replace('{of}', String(series.length))
    .replace('{total}', String(s.total))
    .replace('{last}', fmt(s.last30))
    .replace('{prev}', fmt(s.prev30));

  return (
    <div data-testid="usage-sparkline">
      <div
        role="img"
        aria-label={`${labels.aria} ${summary}`}
        className="flex items-end gap-px rounded bg-gray-50 px-1 dark:bg-gray-800/60"
        style={{ height: TRACK_PX }}
      >
        {series.map((p, i) => {
          const state = p.value === null ? 'nodata' : p.value === 0 ? 'zero' : 'value';
          const title = p.value === null ? labels.barNoData.replace('{day}', p.day) : labels.bar.replace('{day}', p.day).replace('{value}', String(p.value));
          return (
            <div
              key={p.day}
              data-testid={`usage-bar-${i}`}
              data-state={state}
              title={title}
              className={
                state === 'value'
                  ? 'flex-1 rounded-t-sm bg-blue-500'
                  : state === 'zero'
                    ? 'flex-1 bg-gray-400 dark:bg-gray-500'
                    : 'flex-1 bg-gray-200 dark:bg-gray-700'
              }
              style={{ height: state === 'value' ? `${Math.max(4, (p.value! / scale) * 100)}%` : state === 'zero' ? 1 : '100%' }}
            />
          );
        })}
      </div>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="usage-summary">
        {summary}
      </p>
      <p className="mt-1 flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm bg-blue-500" />{labels.legendValue}</span>
        <span className="flex items-center gap-1"><span className="inline-block h-px w-3 bg-gray-400" />{labels.legendZero}</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 bg-gray-200 dark:bg-gray-700" />{labels.legendNoData}</span>
      </p>
    </div>
  );
}
