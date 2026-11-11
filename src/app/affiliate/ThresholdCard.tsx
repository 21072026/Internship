import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries';
import { bpsToPercentText } from '@/lib/affiliatePlanTerms';
import { interpolate } from '@/lib/notificationText';
import { formatDate } from '@/lib/relativeTime';

// "7 / 10 paying customers" (#3543): the partner's progress towards the plan's
// switch to a percent, counted by the commission engine's own ordinal
// (partnerThresholds(), src/lib/affiliateFunnel.ts). The page renders this only
// when the plan has a threshold.
export function ThresholdCard({
  threshold,
  locale,
  L,
}: {
  threshold: { target: number; paying: number; left: number; bps: number; reachedAt: string | null };
  locale: Locale;
  L: Dictionary['affiliatePortal'];
}) {
  const percent = bpsToPercentText(threshold.bps, locale === 'en' ? '.' : ',');
  const shown = Math.min(threshold.paying, threshold.target);
  const width = Math.round((shown / threshold.target) * 100);
  return (
    <Card data-testid="affiliate-threshold">
      <CardHeader>
        <CardTitle>{L.thresholdTitle}</CardTitle>
      </CardHeader>
      <div className="space-y-2 text-sm">
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100" data-testid="affiliate-threshold-count">
          {interpolate(L.thresholdCount, { paying: String(threshold.paying), target: String(threshold.target) })}
        </p>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={threshold.target}
          aria-valuenow={shown}
          aria-label={L.thresholdTitle}
        >
          <div className="h-full rounded-full bg-blue-600" style={{ width: `${width}%` }} />
        </div>
        <p className="text-gray-700 dark:text-gray-300" data-testid="affiliate-threshold-status">
          {threshold.reachedAt
            ? interpolate(L.thresholdReached, { percent, date: formatDate(threshold.reachedAt, locale, { timeZone: 'UTC' }) })
            : threshold.left === 1
              ? interpolate(L.thresholdLeftOne, { percent })
              : interpolate(L.thresholdLeft, { left: String(threshold.left), percent })}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{L.thresholdHint}</p>
      </div>
    </Card>
  );
}
