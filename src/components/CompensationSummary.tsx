'use client';

import { useT, useLocale } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import { hasStructuredCompensation, type CompensationFields } from '@/lib/compensation';

// The structured figures of an offer as one readable block (#1851): base pay
// with its period, hours, contract type, bonuses, equity. Rendered wherever the
// caller is allowed to see compensation at all — the admin panel, the wizard
// preview and the candidate's own card — and nowhere else: the fields simply
// are not in a COMPANY response (canSeeCompensation, src/lib/offers.ts).
// Amounts go through money.ts, never Intl, so a figure reads byte-for-byte the
// same on every machine (see the header there).
export function CompensationSummary({ offer, testId }: { offer: Partial<CompensationFields>; testId?: string }) {
  const t = useT();
  const locale = useLocale();
  if (!hasStructuredCompensation(offer)) return null;
  const c = t.offers.compensation;
  const money = (minor: number) => formatMinorAmount(minor, offer.currency ?? 'EUR', locale);
  const period = offer.basePeriod ? (c.perPeriod as Record<string, string>)[offer.basePeriod] ?? offer.basePeriod : null;
  const contract = offer.contractType ? (c.contractTypes as Record<string, string>)[offer.contractType] ?? offer.contractType : null;

  return (
    <div className="text-sm text-gray-700 dark:text-gray-300 space-y-0.5" data-testid={testId}>
      {offer.baseAmountMinor != null && offer.currency && (
        <p className="font-medium text-gray-900 dark:text-gray-100">
          {money(offer.baseAmountMinor)}
          {period && <span className="font-normal text-gray-500"> {period}</span>}
          {offer.hoursPerWeek != null && (
            <span className="font-normal text-gray-500"> · {c.hoursPerWeek.replace('{n}', String(offer.hoursPerWeek))}</span>
          )}
        </p>
      )}
      {(contract || (offer.baseAmountMinor == null && offer.hoursPerWeek != null)) && (
        <p className="text-gray-600 dark:text-gray-300">
          {contract}
          {contract && offer.baseAmountMinor == null && offer.hoursPerWeek != null && ' · '}
          {offer.baseAmountMinor == null && offer.hoursPerWeek != null && c.hoursPerWeek.replace('{n}', String(offer.hoursPerWeek))}
        </p>
      )}
      {offer.signingBonusMinor != null && offer.currency && <p>{c.signingBonus.replace('{amount}', money(offer.signingBonusMinor))}</p>}
      {offer.otherBonusMinor != null && offer.currency && <p>{c.otherBonus.replace('{amount}', money(offer.otherBonusMinor))}</p>}
      {offer.equityNote && <p>{c.equity.replace('{note}', offer.equityNote)}</p>}
    </div>
  );
}
