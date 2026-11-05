'use client';

import { Link2 } from 'lucide-react';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import { interpolate } from '@/lib/notificationText';
import type { RecordSummary } from '@/lib/affiliateRecordRefRule';

// The affiliate row a support message asks about (#3353), as one short line:
// "Commission · CUST-1 · €25.00" or "Customer · CUST-1". Shown to the partner
// while writing and in the thread, and to the admin in the support inbox.
export function RecordChip({ record, onRemove }: { record: RecordSummary; onRemove?: () => void }) {
  const t = useT();
  const L = t.support;
  const locale = useLocale();
  const text =
    record.kind === 'commission' && record.amountMinor !== null && record.currency
      ? interpolate(L.recordCommission, { customer: record.customerRef, amount: formatMinorAmount(record.amountMinor, record.currency, locale) })
      : interpolate(L.recordCustomer, { customer: record.customerRef });
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-xs text-gray-700 dark:border-gray-700 dark:text-gray-300" data-testid="support-record">
      <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{L.recordAbout}: </span>
      {text}
      {onRemove && (
        <button type="button" onClick={onRemove} className="ml-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-100" aria-label={L.recordRemove} data-testid="support-record-remove">
          ×
        </button>
      )}
    </span>
  );
}
