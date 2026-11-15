import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';
import type { CampaignClicks } from '@/lib/affiliateFunnel';
import type { TrendMonth } from '@/lib/affiliateTrendRule';
import { formatMinorAmount } from '@/lib/money';
import { interpolate } from '@/lib/notificationText';
import { formatDate } from '@/lib/relativeTime';
import { TrendCharts } from './TrendCharts';

// Below the funnel (#3545): the period's earnings per click, the clicks per
// campaign tag (`/r/<code>?c=<tag>`) and the last 12 months. Every number comes
// from src/lib/affiliateFunnel.ts, the aggregate the funnel reads too; the
// period is the funnel's (?period=…). Server-rendered; only the charts are a
// client island.

export function EarningsPerClickCard({
  epcMinor,
  earnedMinor,
  currency,
  clicks,
  locale,
  L,
}: {
  epcMinor: number | null;
  currency: string;
  earnedMinor: number;
  clicks: number;
  locale: Locale;
  L: Dictionary['affiliatePortal'];
}) {
  const money = (minor: number) => formatMinorAmount(minor, currency, locale);
  return (
    <Card data-testid="affiliate-epc">
      <CardHeader>
        <CardTitle>{L.epcTitle}</CardTitle>
      </CardHeader>
      {epcMinor === null ? (
        <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="affiliate-epc-none">{L.epcNone}</p>
      ) : (
        <div className="space-y-1">
          <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100" data-testid="affiliate-epc-value">
            {interpolate(L.epcValue, { amount: money(epcMinor) })}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {interpolate(L.epcDetail, { earned: money(earnedMinor), clicks: String(clicks) })}
          </p>
        </div>
      )}
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{L.epcHint}</p>
    </Card>
  );
}

export function CampaignsCard({
  campaigns,
  totalClicks,
  exampleLink,
  L,
}: {
  campaigns: CampaignClicks[];
  totalClicks: number;
  /** The partner's tracked link with an example tag; null without a tracked link. */
  exampleLink: string | null;
  L: Dictionary['affiliatePortal'];
}) {
  const tagged = campaigns.reduce((n, c) => n + c.clicks, 0);
  const untagged = Math.max(0, totalClicks - tagged);
  return (
    <Card data-testid="affiliate-campaigns">
      <CardHeader>
        <CardTitle>{L.campaignsTitle}</CardTitle>
      </CardHeader>
      {exampleLink && (
        <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
          {interpolate(L.campaignsHint, { example: exampleLink })}
        </p>
      )}
      {campaigns.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="affiliate-campaigns-empty">{L.campaignsEmpty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-gray-500 dark:text-gray-400">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">{L.campaignColumn}</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">{L.campaignClicks}</th>
                <th scope="col" className="py-2 text-right font-medium">{L.campaignUnique}</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.campaign} className="border-t border-gray-100 dark:border-gray-800" data-testid="affiliate-campaign-row">
                  <td className="py-2 pr-4 font-mono text-gray-900 dark:text-gray-100">{c.campaign}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{c.clicks}</td>
                  <td className="py-2 text-right tabular-nums">{c.uniqueClicks}</td>
                </tr>
              ))}
              <tr className="border-t border-gray-100 text-gray-500 dark:border-gray-800 dark:text-gray-400" data-testid="affiliate-campaign-untagged">
                <td className="py-2 pr-4">{L.campaignUntagged}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{untagged}</td>
                <td className="py-2 text-right">–</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function TrendCard({ trend, locale, L }: { trend: TrendMonth[]; locale: Locale; L: Dictionary['affiliatePortal'] }) {
  const months = trend.map((m) => formatDate(`${m.month}-01T00:00:00Z`, locale, { day: undefined, month: 'short', year: '2-digit', timeZone: 'UTC' }));
  return (
    <Card data-testid="affiliate-trend">
      <CardHeader>
        <CardTitle>{L.trendTitle}</CardTitle>
      </CardHeader>
      <TrendCharts
        months={months}
        clicks={trend.map((m) => m.clicks)}
        registrations={trend.map((m) => m.registrations)}
        paying={trend.map((m) => m.paying)}
        labels={{
          clicks: L.trendClicks,
          registrations: L.trendRegistrations,
          paying: L.trendPaying,
          clicksAria: L.trendClicksAria,
          customersAria: L.trendCustomersAria,
        }}
      />
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-gray-600 dark:text-gray-400">{L.trendTable}</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full" data-testid="affiliate-trend-table">
            <thead className="text-left text-gray-500 dark:text-gray-400">
              <tr>
                <th scope="col" className="py-1 pr-4 font-medium">{L.trendMonth}</th>
                <th scope="col" className="py-1 pr-4 text-right font-medium">{L.trendClicks}</th>
                <th scope="col" className="py-1 pr-4 text-right font-medium">{L.trendRegistrations}</th>
                <th scope="col" className="py-1 text-right font-medium">{L.trendPaying}</th>
              </tr>
            </thead>
            <tbody>
              {trend.map((m, i) => (
                <tr key={m.month} className="border-t border-gray-100 dark:border-gray-800" data-testid={`affiliate-trend-row-${m.month}`}>
                  <td className="py-1 pr-4 whitespace-nowrap">{months[i]}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{m.clicks}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{m.registrations}</td>
                  <td className="py-1 text-right tabular-nums">{m.paying}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}
