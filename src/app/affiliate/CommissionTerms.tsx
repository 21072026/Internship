import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries';
import { bpsToPercentText, type PlanTermsView } from '@/lib/affiliatePlanTerms';
import { formatMinorAmount } from '@/lib/money';
import { interpolate } from '@/lib/notificationText';
import { formatDate } from '@/lib/relativeTime';

// The partner's read-only "Your commission terms" box (#3349): the organisation's
// current plan, as data. Nothing here writes; the partner and its org come from the
// session (partnerPlanTerms()), and the page that mounts this has passed the contract gate.
export function CommissionTerms({
  terms,
  planVersion,
  effectiveAt,
  locale,
  L,
}: {
  terms: PlanTermsView | null;
  planVersion: number;
  effectiveAt: string | null;
  locale: Locale;
  L: Dictionary['affiliatePortal'];
}) {
  const money = (minor: number) => formatMinorAmount(minor, terms?.currency ?? 'EUR', locale);
  return (
    <Card data-testid="affiliate-terms">
      <CardHeader>
        <CardTitle>{L.termsTitle}</CardTitle>
      </CardHeader>
      {!terms ? (
        <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="affiliate-terms-none">{L.termsNone}</p>
      ) : (
        <div className="space-y-4 text-sm text-gray-700 dark:text-gray-300">
          <section aria-labelledby="affiliate-terms-bands" className="space-y-1">
            <h3 id="affiliate-terms-bands" className="font-medium text-gray-900 dark:text-gray-100">{L.termsBandsTitle}</h3>
            <dl className="divide-y divide-gray-100 dark:divide-gray-800" data-testid="affiliate-terms-bands">
              {terms.bands.map((b) => (
                <div key={b.upToMinor} className="flex justify-between gap-4 py-1">
                  <dt>{interpolate(L.termsBandUpTo, { amount: money(b.upToMinor) })}</dt>
                  <dd className="whitespace-nowrap font-medium">{money(b.commissionMinor)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-4 py-1">
                <dt>{terms.top.aboveMinor === null ? L.termsBandAll : interpolate(L.termsBandAbove, { amount: money(terms.top.aboveMinor) })}</dt>
                <dd className="whitespace-nowrap font-medium">{money(terms.top.commissionMinor)}</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="affiliate-terms-percent" className="space-y-1" data-testid="affiliate-terms-percent">
            <h3 id="affiliate-terms-percent" className="font-medium text-gray-900 dark:text-gray-100">{L.termsPercentTitle}</h3>
            {terms.percent ? (
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  {interpolate(L.termsPercentRate, {
                    percent: bpsToPercentText(terms.percent.bps, locale === 'en' ? '.' : ','),
                    n: String(terms.percent.startsAtCustomer),
                  })}
                </li>
                <li>{interpolate(L[`termsBoundary${terms.percent.boundaryCustomer}`], { n: String(terms.percent.startsAtCustomer) })}</li>
                <li>
                  {terms.percent.windowMonths === null
                    ? L.termsWindowNone
                    : interpolate(L.termsWindow, { n: String(terms.percent.windowMonths) })}
                </li>
              </ul>
            ) : (
              <p>{L.termsNoPercent}</p>
            )}
          </section>

          <ul className="list-disc space-y-1 pl-5">
            <li>{interpolate(L.termsDue, { n: String(terms.payoutDays) })}</li>
            <li>{L[`termsAfterNotice${terms.afterNotice}`]}</li>
          </ul>

          <p className="text-gray-500" data-testid="affiliate-terms-version">
            {effectiveAt
              ? interpolate(L.termsVersion, { n: String(planVersion), date: formatDate(effectiveAt, locale, { timeZone: 'UTC' }) })
              : interpolate(L.termsVersion, { n: String(planVersion), date: '–' })}{' '}
            {L.termsFrozen}
          </p>
        </div>
      )}
    </Card>
  );
}
