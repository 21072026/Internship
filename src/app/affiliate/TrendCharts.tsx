'use client';

import { BarChart } from '@/components/charts';

// The partner's 12-month trend (#3545) as two bar charts: clicks on their own
// scale, registrations and paying customers side by side on another — on one
// axis the clicks, often a hundred times larger, would flatten the customers to
// nothing. Labels and numbers arrive formatted from the server page; a table
// with the same numbers sits under the charts for anyone who cannot read them.
export function TrendCharts({
  months,
  clicks,
  registrations,
  paying,
  labels,
}: {
  months: string[];
  clicks: number[];
  registrations: number[];
  paying: number[];
  labels: { clicks: string; registrations: string; paying: string; clicksAria: string; customersAria: string };
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">{labels.clicks}</h3>
        <BarChart
          categories={months}
          ariaLabel={labels.clicksAria}
          series={[{ key: 'clicks', label: labels.clicks, color: 'var(--chart-1)', values: clicks }]}
          testId="affiliate-trend-clicks"
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          {labels.registrations} · {labels.paying}
        </h3>
        <BarChart
          categories={months}
          ariaLabel={labels.customersAria}
          series={[
            { key: 'registrations', label: labels.registrations, color: 'var(--chart-2)', values: registrations },
            { key: 'paying', label: labels.paying, color: 'var(--chart-3)', values: paying },
          ]}
          testId="affiliate-trend-customers"
        />
      </div>
    </div>
  );
}
