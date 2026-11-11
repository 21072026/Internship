import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import type { Dictionary } from '@/i18n/dictionaries';
import { FUNNEL_PERIODS, stepRate, type Funnel, type FunnelPeriod } from '@/lib/affiliateFunnelRule';
import { interpolate } from '@/lib/notificationText';

// The partner's funnel (#3543): clicks → registrations → paying → active, each
// step with its share of the step before. The numbers come from the shared
// aggregate (src/lib/affiliateFunnel.ts) the admin screens read too. The period
// is a plain link (?period=…), the page being server-rendered.
export function FunnelCard({ funnel, period, L }: { funnel: Funnel; period: FunnelPeriod; L: Dictionary['affiliatePortal'] }) {
  const steps: { key: string; label: string; value: number; rate: number | null; sub: string | null; first?: boolean }[] = [
    { key: 'clicks', label: L.funnelClicks, value: funnel.clicks, rate: null, sub: interpolate(L.funnelUniqueClicks, { n: String(funnel.uniqueClicks) }), first: true },
    {
      key: 'registrations',
      label: L.funnelRegistrations,
      value: funnel.registrations,
      rate: stepRate(funnel.clicks, funnel.registrations),
      sub: interpolate(L.funnelRegistrationsSplit, { free: String(funnel.freePeriod), left: String(funnel.neverPaid) }),
    },
    { key: 'paying', label: L.funnelPaying, value: funnel.paying, rate: stepRate(funnel.registrations, funnel.paying), sub: null },
    {
      key: 'active',
      label: L.funnelActive,
      value: funnel.active,
      rate: stepRate(funnel.paying, funnel.active),
      sub: interpolate(L.funnelPassive, { n: String(funnel.passive) }),
    },
  ];

  return (
    <Card data-testid="affiliate-funnel">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{L.funnelTitle}</CardTitle>
          <nav className="flex flex-wrap gap-2" aria-label={L.funnelPeriodLabel}>
            {FUNNEL_PERIODS.map((p) => {
              const active = p === period;
              return (
                <Link
                  key={p}
                  href={p === 'month' ? '/affiliate' : `/affiliate?period=${p}`}
                  aria-current={active ? 'page' : undefined}
                  data-testid={`affiliate-funnel-period-${p}`}
                  className={`rounded-full px-3 py-1 text-sm ${active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'}`}
                >
                  {L[`funnelPeriod${p}`]}
                </Link>
              );
            })}
          </nav>
        </div>
      </CardHeader>
      <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s) => (
          <li
            key={s.key}
            data-testid={`affiliate-funnel-${s.key}`}
            className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          >
            <p className="text-sm text-gray-500 dark:text-gray-400">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100" data-testid={`affiliate-funnel-${s.key}-value`}>
              {s.value}
            </p>
            {!s.first && (
              <p className="text-xs text-gray-500 dark:text-gray-400" data-testid={`affiliate-funnel-${s.key}-rate`}>
                {s.rate === null ? L.funnelRateNone : interpolate(L.funnelRate, { n: String(s.rate) })}
              </p>
            )}
            {s.sub && (
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-300" data-testid={`affiliate-funnel-${s.key}-sub`}>
                {s.sub}
              </p>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{L.funnelHint}</p>
    </Card>
  );
}
