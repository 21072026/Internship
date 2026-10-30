import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { getServerDictionary } from '@/i18n/server';
import { CONTRACT_PATH, requirePortalPartner } from '@/lib/affiliatePortal';
import { partnerPlanTerms, partnerSummary } from '@/lib/affiliatePartnerView';
import { AFFILIATE_CURRENCIES } from '@/lib/affiliateProgramSettings';
import { formatMinorAmount } from '@/lib/money';
import { interpolate } from '@/lib/notificationText';
import { formatDate } from '@/lib/relativeTime';
import { CommissionTerms } from './CommissionTerms';
import { CopyLink } from './CopyLink';

// The partner portal's home (docs/affiliate-module.md, #3117): the referral link,
// the totals per commission status and the partnership's state. A partner who
// has not accepted the current contract is sent to it first.
export default async function AffiliateHomePage() {
  const { locale, t } = await getServerDictionary();
  const L = t.affiliatePortal;
  const portal = await requirePortalPartner();
  if (!portal) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="affiliate-no-partner">{L.noPartner}</p>
      </div>
    );
  }

  const [summary, plan] = await Promise.all([partnerSummary(portal.partner), partnerPlanTerms(portal.partner)]);
  const money = (minor: number) => formatMinorAmount(minor, AFFILIATE_CURRENCIES[0], locale);
  const tiles: [string, string, string][] = [
    ['customers', L.customersCount, String(summary.customers)],
    ['PENDING', L.statusPENDING, money(summary.totals.PENDING.amountMinor)],
    ['APPROVED', L.statusAPPROVED, money(summary.totals.APPROVED.amountMinor)],
    ['PAID', L.statusPAID, money(summary.totals.PAID.amountMinor)],
  ];

  return (
    <div className="space-y-6" data-testid="affiliate-portal">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>

      {summary.status === 'SUSPENDED' && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800" role="status">{L.suspended}</p>
      )}
      {summary.status === 'TERMINATED' && summary.noticeEffectiveAt && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800" role="status">
          {interpolate(L.terminated, { date: formatDate(summary.noticeEffectiveAt, locale, { timeZone: 'UTC' }) })}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{L.linkTitle}</CardTitle>
        </CardHeader>
        {summary.link ? (
          <div className="space-y-2">
            <CopyLink value={summary.link} />
            <p className="text-sm text-gray-600 dark:text-gray-400">{L.linkHint}</p>
          </div>
        ) : (
          <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="affiliate-referral-code">{interpolate(L.codeOnly, { code: summary.code })}</p>
        )}
      </Card>

      <section aria-labelledby="affiliate-overview" className="space-y-3">
        <h2 id="affiliate-overview" className="text-lg font-semibold text-gray-900 dark:text-gray-100">{L.overview}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map(([key, label, value]) => (
            <Card key={key} data-testid={`affiliate-total-${key}`}>
              <p className="text-sm text-gray-500">{label}</p>
              <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">{value}</p>
            </Card>
          ))}
        </div>
      </section>

      <CommissionTerms terms={plan.terms} planVersion={plan.planVersion} effectiveAt={plan.effectiveAt} locale={locale} L={L} />

      {portal.contract.currentVersion > 0 && (
        <Link href={CONTRACT_PATH} className="text-sm font-medium text-blue-600 hover:underline">
          {L.viewContract}
        </Link>
      )}
    </div>
  );
}
