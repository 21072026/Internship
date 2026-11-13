'use client';

import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useLocale, useT } from '@/i18n/client';

// The go-live week boxes on /admin/analytics (#2578,
// docs/marketing-vertical/go-live-checklist.md §3): the median time to first
// contact and the share of live trials that carry an end date.
//
// Drawn only when the funnel route returned the two keys, which it does for a
// MARKETING org alone — an INTERNSHIP payload does not carry them, so that page
// is unchanged. The numbers come from src/lib/firstContactRule.ts; this only
// draws them. Counts only: no person and no record is named.

export interface GoLiveMetricsData {
  medianFirstContactHours: number | null;
  firstContact: { medianHours: number | null; contacted: number; waiting: number; contactedBefore: number };
  trialEndCoverage: { total: number; withEnd: number; rate: number | null };
}

export function GoLiveMetricsCard({ data }: { data: GoLiveMetricsData }) {
  const t = useT();
  const locale = useLocale();
  const g = t.funnelGoLive;
  const num = (n: number) => n.toLocaleString(locale);
  const fc = data.firstContact;
  const trial = data.trialEndCoverage;

  return (
    <Card className="mb-6" data-testid="golive-card">
      <CardHeader>
        <CardTitle>{g.title}</CardTitle>
      </CardHeader>
      <p className="text-xs text-gray-500 mb-3">{g.hint}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4" data-testid="golive-first-contact">
          <p className="text-sm text-gray-500">{g.firstContactTitle}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid="golive-first-contact-value">
            {data.medianFirstContactHours === null ? '—' : fillTemplate(g.hours, { hours: num(data.medianFirstContactHours) })}
          </p>
          <p className="mt-1 text-xs text-gray-500" data-testid="golive-first-contact-detail">
            {fillTemplate(g.firstContactDetail, { contacted: num(fc.contacted), waiting: num(fc.waiting) })}
          </p>
          {fc.contactedBefore > 0 && (
            <p className="mt-1 text-xs text-gray-500">{fillTemplate(g.firstContactBefore, { count: num(fc.contactedBefore) })}</p>
          )}
          <p className="mt-2 text-xs text-gray-400">{g.firstContactDefinition}</p>
        </div>
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4" data-testid="golive-trial-coverage">
          <p className="text-sm text-gray-500">{g.trialTitle}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid="golive-trial-coverage-value">
            {trial.rate === null ? '—' : `${num(trial.rate)}%`}
          </p>
          <p className="mt-1 text-xs text-gray-500" data-testid="golive-trial-coverage-detail">
            {trial.total === 0 ? g.trialNone : fillTemplate(g.trialDetail, { withEnd: num(trial.withEnd), total: num(trial.total) })}
          </p>
        </div>
      </div>
    </Card>
  );
}
